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

// ============ BASIC AUTH 逻辑核心 ============
function handleBasicAuth(req: NextRequest) {
  const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
  const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS;

  // 如果未配置环境变量，则不启用 Basic Auth
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return null;

  const authHeader = req.headers.get('authorization');

  if (authHeader) {
    try {
      const authValue = authHeader.split(' ')[1];
      const [user, pwd] = atob(authValue).split(':');

      if (user === BASIC_AUTH_USER && pwd === BASIC_AUTH_PASS) {
        return null; // 验证成功
      }
    } catch (e) {
      console.error('Basic auth decode error');
    }
  }

  // 验证失败或未验证，返回 401
  const response = new NextResponse('Authentication Required', { status: 401 });
  response.headers.set('WWW-Authenticate', 'Basic realm="LobeChat Secure Area"');
  return response;
}

// 辅助函数：判断是否为静态资源或 API
const isStaticOrApi = (pathname: string, backendApiEndpoints: string[]) => {
  return (
    pathname.startsWith('/_next') ||
    pathname.includes('.') || // 带有后缀的文件如 .png, .js, .json
    backendApiEndpoints.some((path) => pathname.startsWith(path))
  );
};
// ============ BASIC AUTH 逻辑结束 ============

const logDefault = debug('middleware:default');
const logNextAuth = debug('middleware:next-auth');
const logClerk = debug('middleware:clerk');

const OIDC_SESSION_HEADER = 'x-oidc-session-sync';

// 这里的 matcher 保持广泛匹配，逻辑交给中间件内部处理
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|icons).*)',
  ],
};

const backendApiEndpoints = ['/api', '/trpc', '/webapi', '/oidc'];

const defaultMiddleware = (request: NextRequest) => {
  const url = new URL(request.url);
  const { pathname } = url;

  // 1. 【关键优化】如果是 API 或 静态资源，跳过 Basic Auth，直接进入 LobeChat 逻辑
  if (isStaticOrApi(pathname, backendApiEndpoints)) {
    // 如果是 API 请求，额外做个简单的 log 跳过
    if (backendApiEndpoints.some((path) => pathname.startsWith(path))) {
      logDefault('Skipping Basic Auth for API: %s', pathname);
    }
  } else {
    // 2. 如果是页面请求（/chat, /settings 等），执行 Basic Auth
    const authResponse = handleBasicAuth(request);
    if (authResponse) return authResponse;
  }

  logDefault('Processing request: %s %s', request.method, request.url);

  // --- 原有 LobeChat 逻辑开始 ---
  if (backendApiEndpoints.some((path) => url.pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const theme = request.cookies.get(LOBE_THEME_APPEARANCE)?.value || parseDefaultThemeFromCountry(request);
  const explicitlyLocale = (url.searchParams.get('hl') || undefined) as Locales | undefined;
  const browserLanguage = parseBrowserLanguage(request.headers);
  const locale = explicitlyLocale || ((request.cookies.get(LOBE_LOCALE_COOKIE)?.value || browserLanguage) as Locales);
  
  const ua = request.headers.get('user-agent');
  const device = new UAParser(ua || '').getDevice();

  const route = RouteVariants.serializeVariants({
    isMobile: device.type === 'mobile',
    locale,
    theme,
  });

  if (appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL) {
    url.protocol = 'http';
    url.host = '127.0.0.1';
    url.port = process.env.PORT || '3210';
  }

  const nextPathname = `/${route}` + (url.pathname === '/' ? '' : url.pathname);
  const nextURL = appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL ? urlJoin(url.origin, nextPathname) : nextPathname;

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

// ... 后续的 RouteMatcher 保持不变 ...
const isPublicRoute = createRouteMatcher(['/api/auth(.*)', '/api/webhooks(.*)', '/webapi(.*)', '/trpc(.*)', '/next-auth/(.*)', '/login', '/signup', '/oauth/consent/(.*)', '/oidc/handoff', '/oidc/token']);
const isProtectedRoute = createRouteMatcher(['/settings(.*)', '/knowledge(.*)', '/onboard(.*)', '/oauth(.*)']);

// NextAuth 包装
const nextAuthMiddleware = NextAuth.auth((req) => {
  // 注入 Basic Auth (仅限非 API/静态资源)
  if (!isStaticOrApi(req.nextUrl.pathname, backendApiEndpoints)) {
    const authResponse = handleBasicAuth(req);
    if (authResponse) return authResponse;
  }

  const response = defaultMiddleware(req);
  const isProtected = appEnv.ENABLE_AUTH_PROTECTION ? !isPublicRoute(req) : isProtectedRoute(req);
  const session = req.auth;
  const isLoggedIn = !!session?.expires;

  response.headers.delete(OAUTH_AUTHORIZED);
  if (isLoggedIn) {
    response.headers.set(OAUTH_AUTHORIZED, 'true');
    if (oidcEnv.ENABLE_OIDC && session?.user?.id) {
      response.headers.set(OIDC_SESSION_HEADER, session.user.id);
    }
  } else if (isProtected) {
    const nextLoginUrl = new URL('/next-auth/signin', req.nextUrl.origin);
    nextLoginUrl.searchParams.set('callbackUrl', req.nextUrl.href);
    return Response.redirect(nextLoginUrl);
  }
  return response;
});

// Clerk 包装
const clerkAuthMiddleware = clerkMiddleware(
  async (auth, req) => {
    // 注入 Basic Auth (仅限非 API/静态资源)
    if (!isStaticOrApi(req.nextUrl.pathname, backendApiEndpoints)) {
      const authResponse = handleBasicAuth(req);
      if (authResponse) return authResponse;
    }

    const isProtected = appEnv.ENABLE_AUTH_PROTECTION ? !isPublicRoute(req) : isProtectedRoute(req);
    if (isProtected) await auth.protect();

    const response = defaultMiddleware(req);
    const data = await auth();

    if (oidcEnv.ENABLE_OIDC && data.userId) {
      response.headers.set(OIDC_SESSION_HEADER, data.userId);
    }
    return response;
  },
  { clockSkewInMs: 60 * 60 * 1000, signInUrl: '/login', signUpUrl: '/signup' }
);

export default authEnv.NEXT_PUBLIC_ENABLE_CLERK_AUTH
  ? clerkAuthMiddleware
  : authEnv.NEXT_PUBLIC_ENABLE_NEXT_AUTH
    ? nextAuthMiddleware
    : defaultMiddleware;
