import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { safeRelativeRedirect } from '@/lib/auth/redirect';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeRelativeRedirect(url.searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', url.origin));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/login?error=invalid_code', url.origin));
  }

  const destination = new URL(next, url.origin);
  if (destination.origin !== url.origin) {
    return NextResponse.redirect(new URL('/dashboard', url.origin));
  }
  return NextResponse.redirect(destination);
}
