// @ts-nocheck
/* eslint-disable @typescript-eslint/no-unused-vars */
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
function basicAuthMiddleware(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  if (!user || !pass) return null;

  const { pathname } = req.nextUrl;

  // 过滤 API 和静态资源
  const isApi = ['/api', '/trpc', '/webapi', '/oidc'].some((p) => pathname.startsWith(p));
  const isAsset = pathname.includes('.') || pathname.startsWith('/_next') || pathname.startsWith('/icons');

  if (isApi || isAsset) return null;

  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    try {
      const authValue = authHeader.split(' ')[1];
      const [u, p] = atob(authValue).split(':');
      if (u === user && p === pass) return null;
    } catch (e) {
      // 加上注释防止 empty block 报错
      console.debug('auth decode failed');
    }
  }

  const res = new NextResponse('Authentication Required', { status: 401 });
  res.headers.set('WWW-Authenticate', 'Basic realm="LobeChat Private"');
  return res;
}

// 只保留用到的 log 实例
const logDefault = debug('middleware:default');
const OIDC_SESSION_HEADER = 'x-oidc-session-sync';

export const config = {
  matcher: [
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
  const authRes = basicAuthMiddleware(request);
  if (authRes) return authRes;

  const url = new URL(request.url);
  logDefault('Processing request: %s %s', request.method, request.url);

  if (backendApiEndpoints.some((path) => url.pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const theme = request.cookies.get(LOBE_THEME_APPEARANCE)?.value || parseDefaultThemeFromCountry(request);
  const browserLanguage = parseBrowserLanguage(request.headers);
  const locale = (url.searchParams.get('hl') || request.cookies.get(LOBE_LOCALE_COOKIE)?.value || browserLanguage) as Locales;

  const device = new UAParser(request.headers.get('user-agent') || '').getDevice();
  const route = RouteVariants.serializeVariants({ isMobile: device.type === 'mobile', locale, theme });

  if (appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL) {
    url.protocol = 'http';
    url.host = '127.0.0.1';
    url.port = process.env.PORT || '3210';
  }

  url.pathname = `/${route}` + (url.pathname === '/' ? '' : url.pathname);
  return NextResponse.rewrite(url, { status: 200 });
};

const isPublicRoute = createRouteMatcher(['/api/auth(.*)', '/api/webhooks(.*)', '/webapi(.*)', '/trpc(.*)', '/next-auth/(.*)', '/login', '/signup', '/oauth/consent/(.*)', '/oidc/handoff', '/oidc/token']);
const isProtectedRoute = createRouteMatcher(['/settings(.*)', '/knowledge(.*)', '/onboard(.*)', '/oauth(.*)']);

const nextAuthMiddleware = NextAuth.auth((req) => {
  const authRes = basicAuthMiddleware(req);
  if (authRes) return authRes;

  const response = defaultMiddleware(req);
  const isProtected = appEnv.ENABLE_AUTH_PROTECTION ? !isPublicRoute(req) : isProtectedRoute(req);
  const session = req.auth;
  const isLoggedIn = !!session?.expires;

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

const clerkAuthMiddleware = clerkMiddleware(
  async (auth, req) => {
    const authRes = basicAuthMiddleware(req);
    if (authRes) return authRes;

    const isProtected = appEnv.ENABLE_AUTH_PROTECTION ? !isPublicRoute(req) : isProtectedRoute(req);
    if (isProtected) await auth.protect();

    const response = defaultMiddleware(req);
    const data = await auth();

    if (oidcEnv.ENABLE_OIDC && data.userId) {
      response.headers.set(OIDC_SESSION_HEADER, data.userId);
    }
    return response;
  },
  { clockSkewInMs: 60 * 60 * 1000, signInUrl: '/login', signUpUrl: '/signup' },
);

export default authEnv.NEXT_PUBLIC_ENABLE_CLERK_AUTH
  ? clerkAuthMiddleware
  : authEnv.NEXT_PUBLIC_ENABLE_NEXT_AUTH
    ? nextAuthMiddleware
    : defaultMiddleware;
