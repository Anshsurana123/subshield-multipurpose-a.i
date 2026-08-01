/**
 * Minimal MCP-over-HTTP client (JSON-RPC 2.0 / streamable-HTTP style) for
 * calling MCP servers that expose an HTTP transport from serverless code.
 *
 * Works with:
 *   - Zepto   : https://mcp.zepto.co.in/mcp      (tools: search, cart, order, history)
 *   - Swiggy  : https://mcp.swiggy.com/food      (tools: search, menu, cart, order — COD)
 *               https://mcp.swiggy.com/im        (Instamart: search, cart, order — COD)
 *
 * We do NOT depend on @modelcontextprotocol/sdk's stdio transport because
 * serverless functions can't spawn child processes. These merchants expose
 * HTTP endpoints, so we speak raw JSON-RPC over fetch.
 *
 * NOTE: Both merchants require OAuth (mobile-number OTP) for order placement.
 * The user completes the OAuth flow once in their MCP client (Cursor/Claude)
 * and supplies the resulting access token via env: ZEPTO_MCP_TOKEN / SWIGGY_MCP_TOKEN.
 * Sandbox reality: order placement on a real merchant will often error until
 * the OAuth token is provided — that error is expected and is how we shake
 * out the production path.
 */

export interface McpServerConfig {
  /** Human label, e.g. 'zepto' | 'swiggy-instamart' */
  name: string;
  /** HTTP MCP endpoint, e.g. https://mcp.zepto.co.in/mcp */
  url: string;
  /** Optional OAuth bearer token (user-provided, stored in env). */
  token?: string;
  /** Which env var holds the token (for error messaging). */
  tokenEnv?: string;
  /** Per-call timeout in ms (default 20000). Multi-step chains that must fit
   *  the 60s serverless ceiling can lower this per server. */
  timeoutMs?: number;
}

export interface McpCallResult {
  ok: boolean;
  server: string;
  tool: string;
  /** Structured result payload from the MCP server (content items). */
  content?: any[];
  /** JSON-serialized text content for logging/replies. */
  text?: string;
  error?: string;
  /** True when the merchant rejected the call (e.g. no auth, bad address). */
  merchantError?: boolean;
}

const RPC_VERSION = '2.0';

// Streamable-HTTP servers (Zepto, Swiggy) issue a `Mcp-Session-Id` response
// header on initialize and require it echoed on every subsequent request.
// Cache it per (url+token) so a tool sequence doesn't need to re-handshake.
const sessionIds = new Map<string, string>();

async function rpcRequest(
  config: McpServerConfig,
  method: string,
  params: any
): Promise<any> {
  const key = cacheKey(config);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const sessionId = sessionIds.get(key);
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: RPC_VERSION,
      id: 1,
      method,
      params,
    }),
    // Default 20s per call; servers whose chains must fit the 60s serverless
    // ceiling (e.g. the multi-step food order) can pass a shorter timeoutMs.
    signal: AbortSignal.timeout(config.timeoutMs ?? 20000),
  });

  if (!res.ok) {
    throw new Error(`${config.name} MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  // Capture the session id issued by the server (present on initialize and
  // sometimes on later responses) so follow-up calls are routed correctly.
  const nextSessionId = res.headers.get('Mcp-Session-Id');
  if (nextSessionId) sessionIds.set(key, nextSessionId);

  const text = await res.text();
  // Streamable HTTP may return either `application/json` or SSE
  // (`text/event-stream` with `data: {...}` lines).
  if (text.startsWith('{')) {
    const msg = JSON.parse(text);
    if (msg.error) throw new Error(`${config.name} ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }
  // SSE envelope: multiple `data:` frames; take the last non-ping one.
  const frames = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6).trim());
  for (let i = frames.length - 1; i >= 0; i--) {
    const msg = JSON.parse(frames[i]);
    if (msg.id === 1) {
      if (msg.error) throw new Error(`${config.name} ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
      return msg.result;
    }
  }
  throw new Error(`${config.name} MCP: no response frame in SSE stream`);
}

// Cache initialize per (url+token) so tool sequences don't re-handshake.
const initCache = new Set<string>();

const cacheKey = (config: McpServerConfig) => `${config.url}|${config.token || ''}`;

// Server sessions are short-lived (unlike 7-day OAuth tokens) — when a stale
// Mcp-Session-Id is rejected, clear both caches and retry once so the flow
// survives without a serverless cold start.
function isStaleSessionError(msg: string): boolean {
  return /Mcp-Session-Id header is required|invalid session|session.*(expired|not found|invalid)/i.test(msg);
}

/** Initialize the MCP session (required handshake), cached per endpoint. */
async function initialize(config: McpServerConfig): Promise<void> {
  const key = cacheKey(config);
  if (initCache.has(key)) return;
  await rpcRequest(config, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'subshield', version: '1.0.0' },
  });
  initCache.add(key);
}

/** Drop cached session state for an endpoint (used for stale-session retries). */
function resetSession(config: McpServerConfig): void {
  sessionIds.delete(cacheKey(config));
  initCache.delete(cacheKey(config));
}

/** List available tools (self-describing — tool names can drift). */
export async function listMcpTools(config: McpServerConfig): Promise<string[]> {
  await initialize(config);
  const result = await rpcRequest(config, 'tools/list', {});
  return Array.isArray(result?.tools) ? result.tools.map((t: any) => t.name) : [];
}

/**
 * Call a tool by name with JSON arguments. Returns a normalized result.
 * `tools/call` responses are `{ content: [{type:'text',text:'...'}, ...] }`.
 */
/**
 * Run one tools/call attempt, normalizing the result. On failure with a stale
 * session id (server sessions expire independently of OAuth tokens), reset the
 * cached session and retry once before giving up.
 */
async function attemptToolCall(
  config: McpServerConfig,
  tool: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  const tryOnce = async (): Promise<McpCallResult> => {
    try {
      await initialize(config);
      const result = await rpcRequest(config, 'tools/call', { name: tool, arguments: args });
      const content: any[] = Array.isArray(result?.content) ? result.content : [];
      const text = content
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');

      const isError =
        result?.isError === true ||
        (/error|failed|unable|cannot|denied|invalid/i.test(text) && !/no error/i.test(text));

      return {
        ok: !isError,
        server: config.name,
        tool,
        content,
        text: text.slice(0, 2000),
        merchantError: isError,
        error: isError ? `Merchant responded with an error: ${text.slice(0, 300)}` : undefined,
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      const authHint = !config.token
        ? ` (no token — set ${config.tokenEnv || 'MCP_TOKEN'} from the OAuth flow in Cursor/Claude)`
        : /(?:HTTP|status\s*[=:]?\s*)401|invalid_token|unauthorized/i.test(msg)
        ? ` (${config.tokenEnv || 'token'} expired/invalid — re-run the OAuth flow and update the env var)`
        : '';
      return {
        ok: false,
        server: config.name,
        tool,
        merchantError: true,
        error: `${msg}${authHint}`,
      };
    }
  };

  const first = await tryOnce();
  if (first.ok || !first.error || !isStaleSessionError(first.error)) return first;

  // Stale session id — clear caches and retry once (fresh handshake).
  resetSession(config);
  return tryOnce();
}

export async function callMcpTool(
  config: McpServerConfig,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<McpCallResult> {
  return attemptToolCall(config, tool, args);
}

// ─── Preset merchant configs ───────────────────────────────────────────────────

export const ZEPTO_MCP: McpServerConfig = {
  name: 'zepto',
  url: process.env.ZEPTO_MCP_URL || 'https://mcp.zepto.co.in/mcp',
  token: process.env.ZEPTO_MCP_TOKEN,
  tokenEnv: 'ZEPTO_MCP_TOKEN',
};

export const SWIGGY_INSTAMART_MCP: McpServerConfig = {
  name: 'swiggy-instamart',
  url: process.env.SWIGGY_MCP_URL || 'https://mcp.swiggy.com/im',
  token: process.env.SWIGGY_MCP_TOKEN,
  tokenEnv: 'SWIGGY_MCP_TOKEN',
};

export const SWIGGY_FOOD_MCP: McpServerConfig = {
  name: 'swiggy-food',
  url: process.env.SWIGGY_FOOD_MCP_URL || 'https://mcp.swiggy.com/food',
  token: process.env.SWIGGY_MCP_TOKEN,
  tokenEnv: 'SWIGGY_MCP_TOKEN',
};

/** Map a product URL host to the MCP merchant that owns it (if any). */
export function mcpMerchantForUrl(url: string): McpServerConfig | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('zepto')) return ZEPTO_MCP;
    if (host.includes('swiggy')) {
      // Instamart for grocery-style paths, food otherwise — default to instamart
      return SWIGGY_INSTAMART_MCP;
    }
    return null;
  } catch {
    return null;
  }
}
