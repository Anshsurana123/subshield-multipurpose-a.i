import assert from "node:assert/strict";
import test from "node:test";

import { McpClient } from "../client.ts";
import {
  InMemoryMcpSchemaSnapshotStore,
  stableToolSchemaHash,
} from "../schema-registry.ts";
import { assertMcpArgumentsValid } from "../schema-validator.ts";
import { McpSessionManager, type McpSessionState } from "../session.ts";
import {
  McpError,
  type McpOAuthCredentialProvider,
  type McpSessionScope,
  type McpToolDefinition,
} from "../types.ts";

const scope: McpSessionScope = {
  userId: "10000000-0000-4000-8000-000000000001",
  provider: "swiggy",
  merchantConnectionId: "20000000-0000-4000-8000-000000000001",
};

const searchTool: McpToolDefinition = {
  name: "catalog.search",
  description: "Search the catalog without changing merchant state.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  },
};

const oauthProvider: McpOAuthCredentialProvider = {
  async resolveMetadata() {
    return { issuer: "https://identity.example.test" };
  },
  async loadAccessToken() {
    return { accessToken: "scoped-access-token", expiresAt: Date.now() + 60_000 };
  },
  async refreshAccessToken() {
    return { accessToken: "refreshed-access-token", expiresAt: Date.now() + 60_000 };
  },
};

function rpcResponse(id: string, result: unknown, headers?: HeadersInit): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result },
    { headers: { "content-type": "application/json", ...headers } },
  );
}

function createFetch(
  callResponse: (
    request: Record<string, unknown>,
    callNumber: number,
  ) => Response,
): { fetch: typeof fetch; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  let calls = 0;
  const implementation = async (
    _input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);

    if (request.method === "initialize") {
      return rpcResponse(
        String(request.id),
        {
          protocolVersion: "test-version",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-server", version: "1.0.0" },
        },
        { "Mcp-Session-Id": `session-${requests.length}` },
      );
    }
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }
    if (request.method === "tools/list") {
      return rpcResponse(String(request.id), { tools: [searchTool] });
    }
    if (request.method === "tools/call") {
      calls += 1;
      return callResponse(request, calls);
    }
    return new Response(null, { status: 500 });
  };
  return { fetch: implementation as typeof fetch, requests };
}

function createClient(fetchImplementation: typeof fetch): McpClient {
  return new McpClient({
    endpoint: "http://127.0.0.1:43123/mcp",
    protocolVersion: "test-version",
    clientInfo: { name: "prava-tests", version: "1.0.0" },
    oauthProvider,
    schemaStore: new InMemoryMcpSchemaSnapshotStore(),
    fetchImplementation,
    allowInsecureLoopback: true,
    requestTimeoutMs: 1_000,
    sleep: async () => undefined,
  });
}

test("session initialization is scoped and concurrency-safe", async () => {
  const sessions = new McpSessionManager();
  let initializeCount = 0;
  const state = {
    scope,
    sessionId: "session-a",
    snapshot: {
      scope,
      protocolVersion: "test-version",
      serverInfo: { name: "test", version: "1" },
      schemaHash: stableToolSchemaHash([searchTool]),
      discoveredAt: new Date(0).toISOString(),
      tools: [searchTool],
    },
  } satisfies McpSessionState;

  const values = await Promise.all(
    Array.from({ length: 10 }, () =>
      sessions.getOrInitialize(scope, async () => {
        initializeCount += 1;
        await Promise.resolve();
        return state;
      }),
    ),
  );
  assert.equal(initializeCount, 1);
  assert.ok(values.every((value) => value.sessionId === "session-a"));

  const otherScope = {
    ...scope,
    userId: "10000000-0000-4000-8000-000000000002",
  };
  await sessions.getOrInitialize(otherScope, async () => ({
    ...state,
    scope: otherScope,
    sessionId: "session-b",
    snapshot: { ...state.snapshot, scope: otherScope },
  }));
  assert.equal(sessions.get(scope)?.sessionId, "session-a");
  assert.equal(sessions.get(otherScope)?.sessionId, "session-b");
});

test("tool schema hashes are canonical and argument validation fails locally", () => {
  const reordered: McpToolDefinition = {
    inputSchema: {
      additionalProperties: false,
      required: ["query"],
      properties: { query: { minLength: 1, type: "string" } },
      type: "object",
    },
    description: searchTool.description,
    name: searchTool.name,
  };
  assert.equal(
    stableToolSchemaHash([searchTool]),
    stableToolSchemaHash([reordered]),
  );
  assert.doesNotThrow(() =>
    assertMcpArgumentsValid({ query: "coffee" }, searchTool.inputSchema),
  );
  assert.throws(
    () => assertMcpArgumentsValid({ query: "", mutate: true }, searchTool.inputSchema),
    (error: unknown) =>
      error instanceof McpError && error.code === "ARGUMENT_VALIDATION_FAILED",
  );
});

test("client performs the lifecycle with unique IDs and prefers structured content", async () => {
  const fixture = createFetch((request) =>
    rpcResponse(String(request.id), {
      structuredContent: { items: [{ id: "item-1" }] },
      content: [{ type: "text", text: "fallback" }],
    }),
  );
  const client = createClient(fixture.fetch);
  const result = await client.callTool<{ items: { id: string }[] }>(
    scope,
    "catalog.search",
    { query: "coffee" },
    { kind: "read" },
  );

  assert.equal(result.source, "structuredContent");
  assert.deepEqual(result.data, { items: [{ id: "item-1" }] });
  assert.deepEqual(
    fixture.requests.map((request) => request.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/call"],
  );
  const ids = fixture.requests
    .map((request) => request.id)
    .filter((id): id is string => typeof id === "string");
  assert.equal(new Set(ids).size, ids.length);
  assert.equal("id" in fixture.requests[1], false);
});

test("client parses SSE and retries one stale session only for reads", async () => {
  const fixture = createFetch((request, callNumber) => {
    if (callNumber === 1) return new Response(null, { status: 404 });
    const id = String(request.id);
    return new Response(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { structuredContent: { available: true } },
      })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const client = createClient(fixture.fetch);
  const result = await client.callTool<{ available: boolean }>(
    scope,
    "catalog.search",
    { query: "tea" },
    { kind: "read" },
  );
  assert.deepEqual(result.data, { available: true });
  assert.equal(
    fixture.requests.filter((request) => request.method === "tools/call").length,
    2,
  );
  assert.equal(
    fixture.requests.filter((request) => request.method === "initialize").length,
    2,
  );
});

test("mutation calls fail closed without both flags and an exact audited hash", async () => {
  const fixture = createFetch((request) =>
    rpcResponse(String(request.id), { structuredContent: { shouldNotRun: true } }),
  );
  const client = createClient(fixture.fetch);
  const previousPurchases = process.env.PURCHASES_ENABLED;
  const previousExecution = process.env.MERCHANT_EXECUTION_ENABLED;
  delete process.env.PURCHASES_ENABLED;
  delete process.env.MERCHANT_EXECUTION_ENABLED;

  try {
    await assert.rejects(
      client.callTool(
        scope,
        "catalog.search",
        { query: "rice" },
        { kind: "mutation" },
      ),
      (error: unknown) =>
        error instanceof McpError && error.code === "MUTATION_DISABLED",
    );
  } finally {
    if (previousPurchases === undefined) delete process.env.PURCHASES_ENABLED;
    else process.env.PURCHASES_ENABLED = previousPurchases;
    if (previousExecution === undefined) {
      delete process.env.MERCHANT_EXECUTION_ENABLED;
    } else {
      process.env.MERCHANT_EXECUTION_ENABLED = previousExecution;
    }
  }

  assert.equal(
    fixture.requests.filter((request) => request.method === "tools/call").length,
    0,
  );
});
