import { NextResponse, type NextRequest } from 'next/server';
import { refreshAuth } from '@/lib/supabase/middleware';

function contentSecurityPolicy(nonce: string): string {
  let supabaseOrigin = '';
  let supabaseWebSocket = '';
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '');
    supabaseOrigin = url.origin;
    supabaseWebSocket = `wss://${url.host}`;
  } catch {
    // Missing Supabase configuration is handled as a signed-out request.
  }

  const developmentEval = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentEval}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${supabaseOrigin ? ` ${supabaseOrigin} ${supabaseWebSocket}` : ''}`,
    "frame-src https://collect.prava.space https://sandbox.collect.prava.space",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(process.env.NODE_ENV === 'production' ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export async function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  const { response, userId } = await refreshAuth(request, requestHeaders);
  response.headers.set('Content-Security-Policy', csp);

  if (request.nextUrl.pathname.startsWith('/dashboard') && !userId) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    const redirect = NextResponse.redirect(loginUrl);
    redirect.headers.set('Content-Security-Policy', csp);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
