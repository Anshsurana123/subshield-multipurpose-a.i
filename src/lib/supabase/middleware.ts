import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function refreshAuth(request: NextRequest, requestHeaders?: Headers): Promise<{
  response: NextResponse;
  userId: string | null;
}> {
  const nextResponse = () => NextResponse.next({
    request: { headers: requestHeaders ?? request.headers },
  });
  let response = nextResponse();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !key) {
    return { response, userId: null };
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = nextResponse();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  return {
    response,
    userId: error || typeof data?.claims?.sub !== 'string' ? null : data.claims.sub,
  };
}
