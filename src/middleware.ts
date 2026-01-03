// @ts-nocheck
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { parseDefaultThemeFromCountry } from '@lobechat/utils/server';
import debug from 'debug';
import { NextRequest, NextResponse } from 'next/server';
import { UAParser } from 'ua-parser-js';
import urlJoin from 'url-join';

import { OAUTH_AUTHORIZED } from '@/const/auth';
import { LOBE_LOCALE_COOKIE } from '@/const/locale';
import { LOBE_THEME_APPEARANCE } from '@/const/theme';
import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import NextAuth from '@/libs/next-auth';
import { Locales } from '@/locales/resources';

import { oidcEnv } from './envs/oidc';
import { parseBrowserLanguage } from './utils/locale';
import { RouteVariants } from './utils/server/routeVariants';

// ==========================================
// 1. Basic Auth 核心校验函数
// ==========================================
function handleBasicAuth(req: NextRequest) {
  const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
  const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS;

  // 如果未配置环境变量，直接跳过认证逻辑
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return null;

  const { pathname } = req.nextUrl;

  // 【核心过滤逻辑】
  // 只有非 API 且非静态资源的路径（即真正的页面访问）才触发认证
  const isApi = ['/api', '/trpc', '/webapi', '/oidc'].some((path) => pathname.startsWith(path));
  const isStatic = pathname.startsWith('/_next') || pathname.includes('.') || pathname.startsWith('/icons');

  // 如果是 API 或静态资源，直接放行
  if (isApi || isStatic) return null;

  // 获取并校验 Authorization 头
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    try {
      const authValue = authHeader.split(' ')[1];
      const [u, p] = atob(authValue).split(':');
      if (u === BASIC_AUTH_USER && p === BASIC_AUTH_PASS) return null; // 认证成功
    } catch (e) {
      // 解码失败时不执行操作，下文将返回 401
    }
  }

  // 认证失败或未认证，返回 401 响应头以弹出浏览器登录框
  const res = new NextResponse('Authentication Required', { status: 401 });
  res.headers.set('WWW-Authenticate', 'Basic realm="LobeChat Private"');
  return res;
}
// ==========================================

// Create debug logger instances
const logDefault = debug('middleware:default');
const logNextAuth = debug('middleware:next-auth');
const logClerk = debug('middleware:clerk');

// OIDC session pre-sync constant
const OIDC_SESSION_HEADER = 'x-oidc-session-sync';

export const config = {
  matcher: [
    // 保持原有的匹配规则
    '/(api|trpc|webapi)(.*)',
    '/',
    '/discover',
    '/discover(.*)',
    '/labs',
    '/chat',
    '/chat(.*)',
    '/changelog(.*)',
    '/settings(.*)',
    '/image',
    '/knowledge',
    '/knowledge(.*)',
    '/profile(.*)',
    '/me',
    '/me(.*)',

    '/login(.*)',
    '/signup(.*)',
    '/next-auth/(.*)',
    '/oauth(.*)',
    '/oidc(.*)',
  ],
};

const backendApiEndpoints = ['/api', '/trpc', '/webapi', '/oidc'];

const defaultMiddleware = (request: NextRequest) => {
  // --- 注入：执行 Basic Auth 校验 ---
  const authRes = handleBasicAuth(request);
  if (authRes) return authRes;

  const url = new URL(request.url);
  logDefault('Processing request: %s %s', request.method, request.url);

  // skip all api requests
  if (backendApiEndpoints.some((path) => url.pathname.startsWith(path))) {
    logDefault('Skipping API request: %s', url.pathname);
    return NextResponse.next();
  }

  // 1. Read user preferences from cookies
  const theme =
    request.cookies.get(LOBE_THEME_APPEARANCE)?.value || parseDefaultThemeFromCountry(request);

  const explicitlyLocale = (url.searchParams.get('hl') || undefined) as Locales | undefined;
  const browserLanguage = parseBrowserLanguage(request.headers);
  const locale =
    explicitlyLocale ||
    ((request.cookies.get(LOBE_LOCALE_COOKIE)?.value || browserLanguage) as Locales);

  const ua = request.headers.get('user-agent');
  const device = new UAParser(ua || '').getDevice();

  logDefault('User preferences: %O', {
    browserLanguage,
    deviceType: device.type,
    hasCookies: {
      locale: !!request.cookies.get(LOBE_LOCALE_COOKIE)?.value,
      theme: !!request.cookies.get(LOBE_THEME_APPEARANCE)?.value,
    },
    locale,
    theme,
  });

  // 2. Create normalized preference values
  const route = RouteVariants.serializeVariants({
    isMobile: device.type === 'mobile',
    locale,
    theme,
  });

  logDefault('Serialized route variant: %s', route);

  if (appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL) {
    url.protocol = 'http';
    url.host = '127.0.0.1';
    url.port = process.env.PORT || '3210';
  }

  const nextPathname = `/${route}` + (url.pathname === '/' ? '' : url.pathname);
  url.pathname = nextPathname;

  const rewrite = NextResponse.rewrite(url, { status: 200 });

  if (explicitlyLocale) {
    const existingLocale = request.cookies.get(LOBE_LOCALE_COOKIE)?.value as Locales | undefined;
    if (!existingLocale) {
      rewrite.cookies.set(LOBE_LOCALE_COOKIE, explicitlyLocale, {
        maxAge: 60 * 60 * 24 * 90,
        path: '/',
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
    }
  }

  return rewrite;
};

const isPublicRoute = createRouteMatcher([
  '/api/auth(.*)',
  '/api/webhooks(.*)',
  '/webapi(.*)',
  '/trpc(.*)',
  '/next-auth/(.*)',
  '/login',
  '/signup',
  '/oauth/consent/(.*)',
  '/oidc/handoff',
  '/oidc/token',
]);

const isProtectedRoute = createRouteMatcher([
  '/settings(.*)',
  '/knowledge(.*)',
  '/onboard(.*)',
  '/oauth(.*)',
]);

// Initialize an Edge compatible NextAuth middleware
const nextAuthMiddleware = NextAuth.auth((req) => {
  // --- 注入：NextAuth 模式下的 Basic Auth ---
  const authRes = handleBasicAuth(req);
  if (authRes) return authRes;

  logNextAuth('NextAuth middleware processing request: %s %s', req.method, req.url);

  const response = defaultMiddleware(req);
  const isProtected = appEnv.ENABLE_AUTH_PROTECTION ? !isPublicRoute(req) : isProtectedRoute(req);
  const session = req.auth;
  const isLoggedIn = !!session?.expires;

  response.headers.delete(OAUTH_AUTHORIZED);
  if (isLoggedIn) {
    response.headers.set(OAUTH_AUTHORIZED, 'true');
    if (
