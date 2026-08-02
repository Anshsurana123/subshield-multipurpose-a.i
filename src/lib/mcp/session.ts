import {
  McpError,
  type McpSchemaSnapshot,
  type McpSessionScope,
} from "./types.ts";

export interface McpSessionState {
  scope: McpSessionScope;
  sessionId: string;
  snapshot: McpSchemaSnapshot;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/u;

export function assertValidMcpScope(
  scope: Readonly<McpSessionScope>,
): void {
  if (!UUID_PATTERN.test(scope.userId)) {
    throw new McpError(
      "INVALID_SCOPE",
      "MCP user scope must contain a valid user UUID.",
    );
  }

  if (!UUID_PATTERN.test(scope.merchantConnectionId)) {
    throw new McpError(
      "INVALID_SCOPE",
      "MCP scope must contain a valid merchant connection UUID.",
    );
  }

  if (!PROVIDER_PATTERN.test(scope.provider)) {
    throw new McpError(
      "INVALID_SCOPE",
      "MCP scope must contain a valid provider identifier.",
    );
  }
}

export function mcpScopeKey(scope: Readonly<McpSessionScope>): string {
  assertValidMcpScope(scope);
  return JSON.stringify([
    scope.userId,
    scope.provider,
    scope.merchantConnectionId,
  ]);
}

function cloneScope(scope: Readonly<McpSessionScope>): McpSessionScope {
  return {
    userId: scope.userId,
    provider: scope.provider,
    merchantConnectionId: scope.merchantConnectionId,
  };
}

function assertStateMatchesScope(
  scope: Readonly<McpSessionScope>,
  state: Readonly<McpSessionState>,
): void {
  if (mcpScopeKey(scope) !== mcpScopeKey(state.scope)) {
    throw new McpError(
      "INVALID_SCOPE",
      "An MCP session initializer returned a different security scope.",
    );
  }

  if (!state.sessionId || /[\r\n]/u.test(state.sessionId)) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP server returned an invalid session identifier.",
    );
  }
}

/**
 * Instance-owned session storage. There is no module-global token, session, or
 * initialization cache. A single manager may safely serve many scopes because
 * every key includes user, provider, and merchant connection identifiers.
 */
export class McpSessionManager {
  private readonly sessions = new Map<string, McpSessionState>();
  private readonly initializations = new Map<
    string,
    Promise<McpSessionState>
  >();
  private readonly generations = new Map<string, number>();

  get(scope: Readonly<McpSessionScope>): McpSessionState | undefined {
    return this.sessions.get(mcpScopeKey(scope));
  }

  async getOrInitialize(
    scope: Readonly<McpSessionScope>,
    initialize: () => Promise<McpSessionState>,
  ): Promise<McpSessionState> {
    const key = mcpScopeKey(scope);
    const current = this.sessions.get(key);
    if (current) return current;

    const pending = this.initializations.get(key);
    if (pending) return pending;

    const generation = this.generations.get(key) ?? 0;
    let promise: Promise<McpSessionState>;
    promise = Promise.resolve()
      .then(initialize)
      .then((state) => {
        assertStateMatchesScope(scope, state);

        if ((this.generations.get(key) ?? 0) !== generation) {
          throw new McpError(
            "STALE_SESSION",
            "The MCP session was invalidated while it was initializing.",
            { retryable: true },
          );
        }

        const stored: McpSessionState = {
          ...state,
          scope: cloneScope(scope),
        };
        this.sessions.set(key, stored);
        return stored;
      })
      .finally(() => {
        if (this.initializations.get(key) === promise) {
          this.initializations.delete(key);
        }
      });

    this.initializations.set(key, promise);
    return promise;
  }

  replace(
    scope: Readonly<McpSessionScope>,
    next: McpSessionState,
    expectedSessionId: string,
  ): boolean {
    const key = mcpScopeKey(scope);
    assertStateMatchesScope(scope, next);
    const current = this.sessions.get(key);
    if (!current || current.sessionId !== expectedSessionId) return false;
    this.sessions.set(key, { ...next, scope: cloneScope(scope) });
    return true;
  }

  invalidate(
    scope: Readonly<McpSessionScope>,
    expectedSessionId?: string,
  ): boolean {
    const key = mcpScopeKey(scope);
    const current = this.sessions.get(key);

    if (
      expectedSessionId !== undefined &&
      current !== undefined &&
      current.sessionId !== expectedSessionId
    ) {
      return false;
    }

    this.sessions.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    return true;
  }
}
