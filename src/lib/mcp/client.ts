import { randomUUID } from "node:crypto";

import { McpOAuthManager } from "./oauth.ts";
import { McpSchemaRegistry } from "./schema-registry.ts";
import { assertMcpArgumentsValid } from "./schema-validator.ts";
import {
  McpSessionManager,
  assertValidMcpScope,
  type McpSessionState,
} from "./session.ts";
import {
  McpError,
  isMcpError,
  type McpApprovedMutationContract,
  type McpJsonRpcErrorObject,
  type McpJsonRpcResponse,
  type McpMutationContractProvider,
  type McpOAuthCredentialProvider,
  type McpRawToolResult,
  type McpSchemaSnapshot,
  type McpSchemaSnapshotStore,
  type McpServerInfo,
  type McpSessionScope,
  type McpToolCallOptions,
  type McpToolCallResult,
  type McpToolDefinition,
} from "./types.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TOOL_PAGES = 100;
const MAX_TOOLS = 10_000;

export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpClientOptions {
  endpoint: string;
  /** Explicitly configured after provider contract discovery. */
  protocolVersion: string;
  clientInfo: McpClientInfo;
  oauthProvider: McpOAuthCredentialProvider;
  schemaStore: McpSchemaSnapshotStore;
  mutationContractProvider?: McpMutationContractProvider;
  sessionManager?: McpSessionManager;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
  maxRetryAfterMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Intended only for local integration tests. */
  allowInsecureLoopback?: boolean;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface RpcTransportResult {
  response: McpJsonRpcResponse;
  sessionIdHeader?: string;
}

interface TransportOptions {
  authorizationHeader: string;
  sessionId?: string;
  signal?: AbortSignal;
  safeToRetry: boolean;
  mutationSent: boolean;
}

interface InitializeResult {
  protocolVersion: string;
  serverInfo: McpServerInfo;
  capabilities: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function validateEndpoint(
  value: string,
  allowInsecureLoopback: boolean,
): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause) {
    throw new McpError(
      "INVALID_CONFIGURATION",
      "The MCP endpoint is not a valid URL.",
      { cause },
    );
  }

  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new McpError(
      "INVALID_CONFIGURATION",
      "The MCP endpoint must not contain credentials or a URL fragment.",
    );
  }

  if (
    endpoint.protocol !== "https:" &&
    !(
      allowInsecureLoopback &&
      endpoint.protocol === "http:" &&
      isLoopback(endpoint.hostname)
    )
  ) {
    throw new McpError(
      "INVALID_CONFIGURATION",
      "The MCP endpoint must use HTTPS.",
    );
  }
  return endpoint;
}

function validateClientInfo(clientInfo: McpClientInfo): void {
  for (const [field, value] of Object.entries(clientInfo)) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 128 ||
      /[\r\n]/u.test(value)
    ) {
      throw new McpError(
        "INVALID_CONFIGURATION",
        `MCP client ${field} is invalid.`,
      );
    }
  }
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const milliseconds = Math.ceil(Number(trimmed) * 1_000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function explicitProviderCode(value: unknown): string | number | undefined {
  if (!isRecord(value)) return undefined;

  for (const key of ["providerCode", "code", "errorCode"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number") {
      return candidate;
    }
  }

  if (isRecord(value.error)) {
    return explicitProviderCode(value.error);
  }
  return undefined;
}

function explicitStaleSession(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.staleSession === true) return true;
  const code = explicitProviderCode(value);
  if (
    code === "STALE_SESSION" ||
    code === "SESSION_NOT_FOUND" ||
    code === "MCP_SESSION_NOT_FOUND"
  ) {
    return true;
  }
  return isRecord(value.error) && explicitStaleSession(value.error);
}

function validateRpcError(error: unknown): McpJsonRpcErrorObject {
  if (
    !isRecord(error) ||
    typeof error.code !== "number" ||
    !Number.isSafeInteger(error.code) ||
    typeof error.message !== "string"
  ) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP server returned an invalid JSON-RPC error object.",
    );
  }
  return {
    code: error.code,
    message: error.message,
    ...(error.data !== undefined ? { data: error.data } : {}),
  };
}

function validateRpcResponse(
  value: unknown,
  expectedId: string,
): McpJsonRpcResponse {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    value.id !== expectedId ||
    (value.result === undefined) === (value.error === undefined)
  ) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP server returned an invalid or mismatched JSON-RPC response.",
    );
  }

  return {
    jsonrpc: "2.0",
    id: expectedId,
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(value.error !== undefined
      ? { error: validateRpcError(value.error) }
      : {}),
  };
}

function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  for (const event of normalized.split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data || data === "[DONE]") continue;

    try {
      messages.push(JSON.parse(data));
    } catch (cause) {
      throw new McpError(
        "PROTOCOL_ERROR",
        "The MCP server returned malformed SSE JSON data.",
        { cause },
      );
    }
  }
  return messages;
}

function parseRpcBody(
  text: string,
  contentType: string,
  expectedId: string,
): McpJsonRpcResponse {
  let payloads: unknown[];

  if (contentType.toLowerCase().includes("text/event-stream")) {
    payloads = parseSseMessages(text);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new McpError(
        "PROTOCOL_ERROR",
        "The MCP server returned malformed JSON.",
        { cause },
      );
    }
    payloads = Array.isArray(parsed) ? parsed : [parsed];
  }

  const match = payloads.find(
    (payload) => isRecord(payload) && payload.id === expectedId,
  );
  if (match === undefined) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP response did not contain the matching JSON-RPC request ID.",
    );
  }
  return validateRpcResponse(match, expectedId);
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new McpError(
        "PROTOCOL_ERROR",
        "The MCP response exceeded the local size limit.",
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function validateInitializeResult(value: unknown): InitializeResult {
  if (
    !isRecord(value) ||
    typeof value.protocolVersion !== "string" ||
    !isRecord(value.serverInfo) ||
    typeof value.serverInfo.name !== "string" ||
    typeof value.serverInfo.version !== "string" ||
    !isRecord(value.capabilities)
  ) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP initialize response is incomplete.",
    );
  }

  return {
    protocolVersion: value.protocolVersion,
    serverInfo: structuredClone(value.serverInfo) as McpServerInfo,
    capabilities: structuredClone(value.capabilities),
  };
}

function validateToolsPage(value: unknown): {
  tools: unknown[];
  nextCursor?: string;
} {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP tools/list result is incomplete.",
    );
  }
  if (
    value.nextCursor !== undefined &&
    (typeof value.nextCursor !== "string" || value.nextCursor.length === 0)
  ) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP tools/list cursor is invalid.",
    );
  }
  return {
    tools: value.tools,
    ...(typeof value.nextCursor === "string"
      ? { nextCursor: value.nextCursor }
      : {}),
  };
}

function parseToolResult(
  value: unknown,
  schemaHash: string,
): McpToolCallResult {
  if (!isRecord(value)) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP tool returned an invalid result object.",
    );
  }

  if (value.isError !== undefined && typeof value.isError !== "boolean") {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP tool returned an invalid isError field.",
    );
  }

  const raw = structuredClone(value) as McpRawToolResult;
  if (value.isError === true) {
    const errorPayload =
      value.structuredContent ?? value._meta ?? value.content ?? value;
    throw new McpError(
      "TOOL_EXECUTION_FAILED",
      "The MCP provider reported that the tool call failed.",
      { providerCode: explicitProviderCode(errorPayload) },
    );
  }

  if (Object.prototype.hasOwnProperty.call(value, "structuredContent")) {
    return {
      data: structuredClone(value.structuredContent),
      source: "structuredContent",
      schemaHash,
      raw,
    };
  }

  if (value.content !== undefined && !Array.isArray(value.content)) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP tool returned an invalid content field.",
    );
  }

  let data: unknown = value.content ?? [];
  if (
    Array.isArray(value.content) &&
    value.content.length === 1 &&
    isRecord(value.content[0]) &&
    value.content[0].type === "text" &&
    typeof value.content[0].text === "string"
  ) {
    try {
      data = JSON.parse(value.content[0].text);
    } catch {
      data = value.content[0].text;
    }
  }

  return { data, source: "content", schemaHash, raw };
}

function validateContractHash(hash: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(hash);
}

export class McpClient {
  private readonly endpoint: URL;
  private readonly protocolVersion: string;
  private readonly clientInfo: McpClientInfo;
  private readonly oauth: McpOAuthManager;
  private readonly schemas: McpSchemaRegistry;
  private readonly mutationContracts?: McpMutationContractProvider;
  private readonly sessions: McpSessionManager;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  private readonly requestNonce = randomUUID();
  private requestSequence = 0;

  constructor(options: McpClientOptions) {
    this.endpoint = validateEndpoint(
      options.endpoint,
      options.allowInsecureLoopback === true,
    );
    if (
      !options.protocolVersion ||
      options.protocolVersion.length > 64 ||
      /[\r\n]/u.test(options.protocolVersion)
    ) {
      throw new McpError(
        "INVALID_CONFIGURATION",
        "An explicit MCP protocol version is required.",
      );
    }
    validateClientInfo(options.clientInfo);
    this.protocolVersion = options.protocolVersion;
    this.clientInfo = { ...options.clientInfo };
    this.oauth = new McpOAuthManager(options.oauthProvider);
    this.schemas = new McpSchemaRegistry(options.schemaStore);
    this.mutationContracts = options.mutationContractProvider;
    this.sessions = options.sessionManager ?? new McpSessionManager();
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRetryAfterMs =
      options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.sleep = options.sleep ?? defaultSleep;

    if (
      !Number.isFinite(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1_000 ||
      this.requestTimeoutMs > 15_000
    ) {
      throw new McpError(
        "INVALID_CONFIGURATION",
        "MCP request timeout must be between one and fifteen seconds.",
      );
    }
    if (
      !Number.isFinite(this.maxRetryAfterMs) ||
      this.maxRetryAfterMs < 0 ||
      this.maxRetryAfterMs > 30_000
    ) {
      throw new McpError(
        "INVALID_CONFIGURATION",
        "MCP Retry-After limit must be between zero and thirty seconds.",
      );
    }
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `${this.requestNonce}:${this.requestSequence}`;
  }

  private async fetchWithTimeout(
    body: RpcRequest | RpcNotification,
    options: TransportOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      return await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: options.authorizationHeader,
          "Content-Type": "application/json",
          "MCP-Protocol-Version": this.protocolVersion,
          ...(options.sessionId
            ? { "Mcp-Session-Id": options.sessionId }
            : {}),
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) {
        throw new McpError(
          "REQUEST_TIMEOUT",
          "The MCP request timed out.",
          {
            retryable: options.safeToRetry,
            outcomeUnknown: options.mutationSent,
            cause,
          },
        );
      }
      if (options.signal?.aborted) {
        throw new McpError(
          "REQUEST_CANCELLED",
          "The MCP request was cancelled.",
          { outcomeUnknown: options.mutationSent, cause },
        );
      }
      throw new McpError(
        "TRANSPORT_FAILURE",
        "The MCP request could not be completed.",
        {
          retryable: options.safeToRetry,
          outcomeUnknown: options.mutationSent,
          cause,
        },
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async throwHttpError(
    response: Response,
    body: string,
    options: TransportOptions,
  ): Promise<never> {
    let structured: unknown;
    if (body) {
      try {
        structured = JSON.parse(body);
      } catch {
        structured = undefined;
      }
    }
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const providerCode = explicitProviderCode(structured);

    if (response.status === 401) {
      throw new McpError(
        "AUTHENTICATION_REQUIRED",
        "The merchant MCP credential was rejected.",
        { httpStatus: 401, providerCode, retryable: options.safeToRetry },
      );
    }
    if (
      options.sessionId &&
      (response.status === 404 || explicitStaleSession(structured))
    ) {
      throw new McpError(
        "STALE_SESSION",
        "The merchant MCP session is no longer valid.",
        {
          httpStatus: response.status,
          providerCode,
          retryable: options.safeToRetry,
        },
      );
    }
    if (response.status === 429) {
      throw new McpError("RATE_LIMITED", "The merchant MCP rate limit was reached.", {
        httpStatus: 429,
        providerCode,
        retryAfterMs,
        retryable: options.safeToRetry,
      });
    }
    throw new McpError("HTTP_FAILURE", "The merchant MCP request was rejected.", {
      httpStatus: response.status,
      providerCode,
      retryAfterMs,
      retryable: options.safeToRetry && response.status >= 500,
      outcomeUnknown: options.mutationSent && response.status >= 500,
    });
  }

  private async postRpc(
    request: RpcRequest,
    options: TransportOptions,
  ): Promise<RpcTransportResult> {
    let retryAfterAttempted = false;

    while (true) {
      const response = await this.fetchWithTimeout(request, options);
      const body = await readBoundedResponse(response);
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const eligibleStatus =
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;

      if (
        !response.ok &&
        options.safeToRetry &&
        !retryAfterAttempted &&
        eligibleStatus &&
        retryAfterMs !== undefined &&
        retryAfterMs <= this.maxRetryAfterMs
      ) {
        retryAfterAttempted = true;
        try {
          await this.sleep(retryAfterMs, options.signal);
        } catch (cause) {
          throw new McpError(
            "REQUEST_CANCELLED",
            "The MCP Retry-After wait was cancelled.",
            { cause },
          );
        }
        continue;
      }

      if (!response.ok) {
        await this.throwHttpError(response, body, options);
      }
      if (!body) {
        throw new McpError(
          "PROTOCOL_ERROR",
          "The MCP server returned an empty JSON-RPC response.",
          { outcomeUnknown: options.mutationSent },
        );
      }

      const rpcResponse = parseRpcBody(
        body,
        response.headers.get("content-type") ?? "application/json",
        request.id,
      );
      if (rpcResponse.error) {
        const providerCode = explicitProviderCode(rpcResponse.error.data);
        if (options.sessionId && explicitStaleSession(rpcResponse.error.data)) {
          throw new McpError(
            "STALE_SESSION",
            "The merchant MCP session is no longer valid.",
            {
              providerCode,
              rpcCode: rpcResponse.error.code,
              retryable: options.safeToRetry,
            },
          );
        }
        throw new McpError(
          "REMOTE_ERROR",
          "The MCP provider returned a JSON-RPC error.",
          {
            providerCode,
            rpcCode: rpcResponse.error.code,
          },
        );
      }

      const sessionIdHeader = response.headers.get("mcp-session-id") ?? undefined;
      if (sessionIdHeader && /[\r\n]/u.test(sessionIdHeader)) {
        throw new McpError(
          "PROTOCOL_ERROR",
          "The MCP server returned an invalid session identifier.",
        );
      }
      return { response: rpcResponse, sessionIdHeader };
    }
  }

  private async postNotification(
    notification: RpcNotification,
    options: TransportOptions,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(notification, options);
    const body = await readBoundedResponse(response);
    if (!response.ok) {
      await this.throwHttpError(response, body, options);
    }
    // MCP notifications normally return 202/204 with no body. If a server does
    // return a body, it must at least be syntactically valid JSON or SSE data.
    if (body) {
      const contentType = response.headers.get("content-type") ?? "application/json";
      if (contentType.toLowerCase().includes("text/event-stream")) {
        parseSseMessages(body);
      } else {
        try {
          JSON.parse(body);
        } catch (cause) {
          throw new McpError(
            "PROTOCOL_ERROR",
            "The MCP notification response was malformed.",
            { cause },
          );
        }
      }
    }
  }

  private async listTools(
    authorizationHeader: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const tools: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const request: RpcRequest = {
        jsonrpc: "2.0",
        id: this.nextRequestId(),
        method: "tools/list",
        ...(cursor ? { params: { cursor } } : {}),
      };
      const { response } = await this.postRpc(request, {
        authorizationHeader,
        sessionId,
        signal,
        safeToRetry: true,
        mutationSent: false,
      });
      const pageResult = validateToolsPage(response.result);
      tools.push(...pageResult.tools);
      if (tools.length > MAX_TOOLS) {
        throw new McpError(
          "PROTOCOL_ERROR",
          "The MCP provider returned too many tools.",
        );
      }
      if (!pageResult.nextCursor) return tools;
      if (seenCursors.has(pageResult.nextCursor)) {
        throw new McpError(
          "PROTOCOL_ERROR",
          "The MCP tools/list cursor repeated.",
        );
      }
      seenCursors.add(pageResult.nextCursor);
      cursor = pageResult.nextCursor;
    }

    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP tools/list pagination limit was exceeded.",
    );
  }

  private async initializeWithAuthorization(
    scope: Readonly<McpSessionScope>,
    authorizationHeader: string,
    signal?: AbortSignal,
  ): Promise<McpSessionState> {
    const initializeRequest: RpcRequest = {
      jsonrpc: "2.0",
      id: this.nextRequestId(),
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
    };
    const initialized = await this.postRpc(initializeRequest, {
      authorizationHeader,
      signal,
      safeToRetry: true,
      mutationSent: false,
    });
    const result = validateInitializeResult(initialized.response.result);
    if (result.protocolVersion !== this.protocolVersion) {
      throw new McpError(
        "PROTOCOL_ERROR",
        "The MCP server negotiated an unsupported protocol version.",
      );
    }
    if (!initialized.sessionIdHeader) {
      throw new McpError(
        "PROTOCOL_ERROR",
        "The MCP server did not return Mcp-Session-Id.",
      );
    }

    await this.postNotification(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        authorizationHeader,
        sessionId: initialized.sessionIdHeader,
        signal,
        safeToRetry: false,
        mutationSent: false,
      },
    );

    const tools = await this.listTools(
      authorizationHeader,
      initialized.sessionIdHeader,
      signal,
    );
    const snapshot = await this.schemas.register({
      scope,
      protocolVersion: result.protocolVersion,
      serverInfo: result.serverInfo,
      tools,
    });
    return {
      scope: { ...scope },
      sessionId: initialized.sessionIdHeader,
      snapshot,
    };
  }

  private async initializeFresh(
    scope: Readonly<McpSessionScope>,
    forceRefresh: boolean,
    signal?: AbortSignal,
  ): Promise<McpSessionState> {
    const authorization = await this.oauth.authorize(scope, { forceRefresh });
    try {
      return await this.initializeWithAuthorization(
        scope,
        authorization.authorizationHeader,
        signal,
      );
    } catch (error) {
      if (
        !forceRefresh &&
        isMcpError(error) &&
        error.code === "AUTHENTICATION_REQUIRED"
      ) {
        const refreshed = await this.oauth.authorize(scope, {
          forceRefresh: true,
        });
        return this.initializeWithAuthorization(
          scope,
          refreshed.authorizationHeader,
          signal,
        );
      }
      throw error;
    }
  }

  private getSession(
    scope: Readonly<McpSessionScope>,
    options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<McpSessionState> {
    assertValidMcpScope(scope);
    if (options.forceRefresh) this.sessions.invalidate(scope);
    return this.sessions.getOrInitialize(scope, () =>
      this.initializeFresh(
        scope,
        options.forceRefresh === true,
        options.signal,
      ),
    );
  }

  async discoverTools(
    scope: Readonly<McpSessionScope>,
    signal?: AbortSignal,
  ): Promise<McpSchemaSnapshot> {
    const state = await this.getSession(scope, { signal });
    return structuredClone(state.snapshot) as McpSchemaSnapshot;
  }

  private findTool(
    snapshot: Readonly<McpSchemaSnapshot>,
    toolName: string,
  ): McpToolDefinition {
    const tool = snapshot.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new McpError(
        "TOOL_NOT_FOUND",
        "The requested tool is not present in the discovered MCP contract.",
      );
    }
    return tool;
  }

  private assertExpectedSchema(
    snapshot: Readonly<McpSchemaSnapshot>,
    expectedSchemaHash?: string,
  ): void {
    if (
      expectedSchemaHash !== undefined &&
      snapshot.schemaHash !== expectedSchemaHash
    ) {
      throw new McpError(
        "SCHEMA_MISMATCH",
        "The MCP contract changed after it was reviewed.",
      );
    }
  }

  private async refreshSchemaBeforeMutation(
    scope: Readonly<McpSessionScope>,
    initial: McpSessionState,
    signal?: AbortSignal,
  ): Promise<McpSessionState> {
    let state = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const authorization = await this.oauth.authorize(scope, {
          forceRefresh: attempt === 1,
        });
        const tools = await this.listTools(
          authorization.authorizationHeader,
          state.sessionId,
          signal,
        );
        const snapshot = await this.schemas.register({
          scope,
          protocolVersion: state.snapshot.protocolVersion,
          serverInfo: state.snapshot.serverInfo,
          tools,
        });
        const next = { ...state, snapshot };
        this.sessions.replace(scope, next, state.sessionId);
        return next;
      } catch (error) {
        const canReinitialize =
          attempt === 0 &&
          isMcpError(error) &&
          (error.code === "STALE_SESSION" ||
            error.code === "AUTHENTICATION_REQUIRED");
        if (!canReinitialize) throw error;
        this.sessions.invalidate(scope, state.sessionId);
        state = await this.getSession(scope, {
          forceRefresh: error.code === "AUTHENTICATION_REQUIRED",
          signal,
        });
      }
    }
    return state;
  }

  private async assertMutationAllowed(
    scope: Readonly<McpSessionScope>,
    snapshot: Readonly<McpSchemaSnapshot>,
    toolName: string,
  ): Promise<McpApprovedMutationContract> {
    if (
      process.env.PURCHASES_ENABLED !== "1" ||
      process.env.MERCHANT_EXECUTION_ENABLED !== "1"
    ) {
      throw new McpError(
        "MUTATION_DISABLED",
        "Merchant mutations are disabled by the purchase safety gates.",
      );
    }
    if (!this.mutationContracts) {
      throw new McpError(
        "CONTRACT_DISCOVERY_REQUIRED",
        "No audited MCP mutation contract is configured.",
      );
    }

    let contract: McpApprovedMutationContract | null;
    try {
      contract = await this.mutationContracts.getApprovedContract(scope);
    } catch (cause) {
      throw new McpError(
        "CONTRACT_DISCOVERY_REQUIRED",
        "The audited MCP mutation contract could not be loaded.",
        { cause },
      );
    }
    if (!contract || !validateContractHash(contract.schemaHash)) {
      throw new McpError(
        "CONTRACT_DISCOVERY_REQUIRED",
        "An exact audited MCP schema hash is required for mutations.",
      );
    }
    if (contract.schemaHash !== snapshot.schemaHash) {
      throw new McpError(
        "SCHEMA_MISMATCH",
        "The live MCP schema does not match the audited mutation contract.",
      );
    }
    if (!contract.approvedToolNames.includes(toolName)) {
      throw new McpError(
        "MUTATION_TOOL_NOT_APPROVED",
        "The requested MCP mutation tool has not been reviewed.",
      );
    }
    return contract;
  }

  private async executeTool(
    scope: Readonly<McpSessionScope>,
    state: Readonly<McpSessionState>,
    toolName: string,
    argumentsValue: Record<string, unknown>,
    options: McpToolCallOptions,
  ): Promise<McpToolCallResult> {
    this.assertExpectedSchema(state.snapshot, options.expectedSchemaHash);
    const tool = this.findTool(state.snapshot, toolName);
    assertMcpArgumentsValid(argumentsValue, tool.inputSchema);

    const authorization = await this.oauth.authorize(scope);
    const request: RpcRequest = {
      jsonrpc: "2.0",
      id: this.nextRequestId(),
      method: "tools/call",
      params: { name: toolName, arguments: argumentsValue },
    };
    const { response } = await this.postRpc(request, {
      authorizationHeader: authorization.authorizationHeader,
      sessionId: state.sessionId,
      signal: options.signal,
      safeToRetry: options.kind === "read",
      mutationSent: options.kind === "mutation",
    });
    return parseToolResult(response.result, state.snapshot.schemaHash);
  }

  async callTool<T = unknown>(
    scope: Readonly<McpSessionScope>,
    toolName: string,
    argumentsValue: Record<string, unknown>,
    options: McpToolCallOptions,
  ): Promise<McpToolCallResult<T>> {
    if (!toolName || toolName.length > 256 || /[\u0000-\u001f\u007f]/u.test(toolName)) {
      throw new McpError("TOOL_NOT_FOUND", "The requested MCP tool name is invalid.");
    }

    let state = await this.getSession(scope, { signal: options.signal });

    if (options.kind === "mutation") {
      // tools/list is refreshed immediately before a mutation. A stale session
      // may be recovered here because no merchant mutation has been sent yet.
      state = await this.refreshSchemaBeforeMutation(
        scope,
        state,
        options.signal,
      );
      await this.assertMutationAllowed(scope, state.snapshot, toolName);
      return (await this.executeTool(
        scope,
        state,
        toolName,
        argumentsValue,
        options,
      )) as McpToolCallResult<T>;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return (await this.executeTool(
          scope,
          state,
          toolName,
          argumentsValue,
          options,
        )) as McpToolCallResult<T>;
      } catch (error) {
        const recoverable =
          attempt === 0 &&
          isMcpError(error) &&
          (error.code === "STALE_SESSION" ||
            error.code === "AUTHENTICATION_REQUIRED");
        if (!recoverable) throw error;

        this.sessions.invalidate(scope, state.sessionId);
        state = await this.getSession(scope, {
          forceRefresh: error.code === "AUTHENTICATION_REQUIRED",
          signal: options.signal,
        });
        this.assertExpectedSchema(state.snapshot, options.expectedSchemaHash);
      }
    }

    throw new McpError(
      "PROTOCOL_ERROR",
      "The MCP read retry loop ended unexpectedly.",
    );
  }
}
