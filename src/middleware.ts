// @ts-nocheck
/* eslint-disable */
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
// 1. Basic Auth 核心逻辑
// ==========================================
function handleBasicAuth(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  if (!user || !pass) return null;

  const { pathname } = req.nextUrl;
  const isApi = ['/api', '/trpc', '/webapi', '/oidc'].some((path) => pathname.startsWith(path));
  const isStatic = pathname.startsWith('/_next') || pathname.includes('.') || pathname.startsWith('/icons');

  if (isApi || isStatic) return null;

  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    try {
      const authValue = authHeader.split(' ')[1];
      const [u, p] = atob(authValue).split(':');
      if (u === user && p === pass) return null;
    } catch (e) {}
  }

  const res = new NextResponse('Authentication Required', { status: 401 });
  res.headers.set('WWW-Authenticate', 'Basic realm="LobeChat Private"');
  return res;
}

// 日志实例
const logDefault = debug('middleware:default');
const logNextAuth = debug('middleware:next-auth');
const logClerk = debug('middleware:clerk');
const OIDC_SESSION_HEADER = 'x-oidc-session-sync';

export const config = {
  matcher: ['/(api|trpc|webapi)(.*)', '/', '/discover', '/discover(.*)', '/labs', '/chat', '/chat(.*)', '/changelog(.*)', '/settings(.*)', '/image', '/knowledge', '/knowledge(.*)', '/profile(.*)', '/me', '/me(.*)', '/login(.*)', '/signup(.*)', '/next-auth/(.*)', '/oauth(.*)', '/oidc(.*)'],
};

const backendApiEndpoints = ['/api', '/trpc', '/webapi', '/oidc'];

// 默认中间件逻辑
const defaultMiddleware = (request: NextRequest) => {
  const authRes = handleBasicAuth(request);
  if (authRes) return authRes;

  const url = new URL(request.url);
  if (backendApiEndpoints.some((path) => url.pathname.startsWith(path))) return NextResponse.next();

  const theme = request.cookies.get(LOBE_THEME_APPEARANCE)?.value || parseDefaultThemeFromCountry(request);
  const explicitlyLocale = (url.searchParams.get('hl') || undefined) as Locales | undefined;
  const browserLanguage = parseBrowserLanguage(request.headers);
  const locale = explicitlyLocale || ((request.cookies.get(LOBE_LOCALE_COOKIE)?.value || browserLanguage) as Locales);

  const device = new UAParser(request.headers.get('user-agent') || '').getDevice();
  const route = RouteVariants.serializeVariants({ isMobile: device.type === 'mobile', locale, theme });

  if (appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL) {
    url.protocol = 'http';
    url.host = '127.0.0.1';
    url.port = process.env.PORT || '3210';
  }

  url.pathname = `/${route}` + (url.pathname === '/' ? '' : url.pathname);
  const rewrite = NextResponse.rewrite(url, { status: 200 });

  if (explicitlyLocale && !request.cookies.get(LOBE_LOCALE_COOKIE)?.value) {
    rewrite.cookies.set(LOBE_LOCALE_COOKIE, explicitlyLocale, { maxAge: 60 * 60 * 24 * 90, path: '/', sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  }
  return rewrite;
};

const isPublicRoute = createRouteMatcher(['/api/auth(.*)', '/api/webhooks(.*)', '/webapi(.*)', '/trpc(.*)', '/next-auth/(.*)', '/login', '/signup', '/oauth/consent/(.*)', '/oidc/handoff', '/oidc/token']);
const isProtectedRoute = createRouteMatcher(['/settings(.*)', '/knowledge(.*)', '/onboard(.*)', '/oauth(.*)']);

// NextAuth 模式
const nextAuthMiddleware = NextAuth.auth((req) => {
  const authRes = handleBasicAuth(req);
  if (authRes) return authRes;
  const response = defaultMiddleware(req);
  const isProtected = appEnv.ENABLE_AUTH_PROTECTION ? !isPublicRoute(req) : isProtectedRoute(req);
  const isLoggedIn = !!req.auth?.expires;
  if (isLoggedIn) {
    response.headers.set(OAUTH_AUTHORIZED, 'true');
  } else if (isProtected) {
    const nextLoginUrl = new URL('/next-auth/signin', req.nextUrl.origin);
    nextLoginUrl.searchParams.set('callbackUrl', req.nextUrl.href);
    return Response.redirect(nextLoginUrl);
  }
  return response;
});

// Clerk 模式
const clerkAuthMiddleware = clerkMiddleware(async (auth, req) => {
  const authRes = handleBasicAuth(req);
  if (authRes) return authRes;
  const isProtected = appEnv.ENABLE_AUTH_PROTECTION ? !isPublicRoute(req) : isProtectedRoute(req);
  if (isProtected) await auth.protect();
  return defaultMiddleware(req);
});

// ==========================================
// 最后导出逻辑：使用简单的判定确保不会出错
// ==========================================
let finalMiddleware = defaultMiddleware;

if (authEnv.NEXT_PUBLIC_ENABLE_CLERK_AUTH) {
  finalMiddleware = clerkAuthMiddleware;
} else if (authEnv.NEXT_PUBLIC_ENABLE_NEXT_AUTH) {
  finalMiddleware = nextAuthMiddleware;
}

export default finalMiddleware;
