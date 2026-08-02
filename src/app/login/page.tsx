'use client';

import { FormEvent, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { safeRelativeRedirect } from '@/lib/auth/redirect';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const callbackUrl = new URL('/auth/callback', window.location.origin);
      const requestedNext = new URLSearchParams(window.location.search).get('next');
      const next = safeRelativeRedirect(requestedNext, '');
      if (next) {
        callbackUrl.searchParams.set('next', next);
      }

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: callbackUrl.toString() },
      });
      if (error) throw error;
      setMessage('Check your email for a secure sign-in link.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to sign in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f7f4] px-4 text-[#17201c]">
      <form onSubmit={signIn} className="w-full max-w-sm rounded-2xl border border-[#dfe5df] bg-white p-7 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#176b4b]">SubShield</p>
        <h1 className="mt-2 text-2xl font-bold">Sign in</h1>
        <p className="mt-2 text-sm leading-6 text-[#68756d]">Use a secure email link to access your private merchant connections and tracked products.</p>
        <label className="mt-6 block text-xs font-semibold text-[#48574f]" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-2 w-full rounded-lg border border-[#d8e0d9] px-3 py-2.5 text-sm outline-none focus:border-[#176b4b]"
        />
        <button disabled={submitting} className="mt-4 w-full rounded-lg bg-[#176b4b] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {submitting ? 'Sending…' : 'Email me a sign-in link'}
        </button>
        {message && <p role="status" className="mt-4 text-sm text-[#526259]">{message}</p>}
      </form>
    </main>
  );
}
