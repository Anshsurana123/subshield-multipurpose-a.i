import { getSupabaseAdmin } from './supabase/server';
import { chromium } from 'playwright-core';

export interface BrowserbaseSessionInfo {
  sessionId: string;
  contextId: string;
  liveUrl: string;
}

export async function createAuthSession(userId?: string): Promise<BrowserbaseSessionInfo> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey || !projectId) {
    throw new Error('Browserbase API key or Project ID missing from environment variables.');
  }

  // 1. Create a Browserbase Context (persistent browser profile / cookies)
  const contextRes = await fetch('https://api.browserbase.com/v1/contexts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bb-api-key': apiKey,
    },
    body: JSON.stringify({ projectId }),
  });

  if (!contextRes.ok) {
    const errorText = await contextRes.text();
    throw new Error(`Failed to create Browserbase context: ${errorText}`);
  }

  const contextData = await contextRes.json();
  const contextId = contextData.id;

  // 2. Create a Session tied to this Context
  const sessionRes = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bb-api-key': apiKey,
    },
    body: JSON.stringify({
      projectId,
      browserSettings: {
        context: {
          id: contextId,
        },
      },
    }),
  });

  if (!sessionRes.ok) {
    const errorText = await sessionRes.text();
    throw new Error(`Failed to create Browserbase session: ${errorText}`);
  }

  const sessionData = await sessionRes.json();
  const sessionId = sessionData.id;
  const connectUrl = sessionData.connectUrl;
  const liveUrl = `https://www.browserbase.com/sessions/${sessionId}`;

  // 3. Save context to user record in Supabase if userId is provided
  if (userId) {
    await getSupabaseAdmin().from('users').upsert({
      id: userId,
      browserbase_context_id: contextId,
      updated_at: new Date().toISOString(),
    });
  }

  // 4. Navigate THAT EXACT session to Google Sign-In page via CDP before returning to user
  if (connectUrl) {
    try {
      console.log(`[BrowserbaseAuth] Connecting via CDP to session ${sessionId}...`);
      const browser = await chromium.connectOverCDP(connectUrl);
      const defaultContext = browser.contexts()[0];
      const page = defaultContext.pages()[0] || (await defaultContext.newPage());

      console.log(`[BrowserbaseAuth] Navigating session ${sessionId} to Google Sign-In...`);
      await page.goto('https://accounts.google.com/ServiceLogin', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      console.log(`[BrowserbaseAuth] Session ${sessionId} successfully navigated to Google Sign-In!`);
    } catch (err) {
      console.error('[BrowserbaseAuth] CDP Google Sign-In navigation error:', err);
    }
  }

  return {
    sessionId,
    contextId,
    liveUrl,
  };
}

export async function saveContextForUser(userId: string, contextId: string): Promise<void> {
  await getSupabaseAdmin().from('users').upsert({
    id: userId,
    browserbase_context_id: contextId,
    updated_at: new Date().toISOString(),
  });
}

export async function getContextForUser(userId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('users')
    .select('browserbase_context_id')
    .eq('id', userId)
    .single();

  if (error || !data) return null;
  return data.browserbase_context_id;
}
