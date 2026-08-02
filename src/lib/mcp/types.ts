export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export type JsonSchema = boolean | { [keyword: string]: JsonValue };

export interface McpSessionScope {
  userId: string;
  provider: string;
  merchantConnectionId: string;
}

export interface McpOAuthMetadata {
  issuer?: string;
  tokenEndpoint?: string;
  resource?: string;
  scopes?: readonly string[];
  [key: string]: unknown;
}

export interface McpAccessToken {
  /** The raw token is intentionally only returned by the injected credential provider. */
  accessToken: string;
  tokenType?: string;
  expiresAt?: number;
}

export interface McpOAuthCredentialProvider {
  resolveMetadata(scope: Readonly<McpSessionScope>): Promise<McpOAuthMetadata>;
  loadAccessToken(
    scope: Readonly<McpSessionScope>,
    metadata: Readonly<McpOAuthMetadata>,
  ): Promise<McpAccessToken | null>;
  refreshAccessToken(
    scope: Readonly<McpSessionScope>,
    metadata: Readonly<McpOAuthMetadata>,
  ): Promise<McpAccessToken>;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  /** Preserve provider extensions returned by tools/list. */
  [key: string]: unknown;
}

export interface McpServerInfo {
  name: string;
  version: string;
  [key: string]: unknown;
}

export interface McpSchemaSnapshot {
  scope: McpSessionScope;
  protocolVersion: string;
  serverInfo: McpServerInfo;
  schemaHash: string;
  discoveredAt: string;
  tools: readonly McpToolDefinition[];
}

export interface McpSchemaSnapshotStore {
  save(snapshot: Readonly<McpSchemaSnapshot>): Promise<void>;
}

export interface McpApprovedMutationContract {
  /** An audited tools/list hash, never a value supplied by an end user. */
  schemaHash: string;
  approvedToolNames: readonly string[];
}

export interface McpMutationContractProvider {
  getApprovedContract(
    scope: Readonly<McpSessionScope>,
  ): Promise<McpApprovedMutationContract | null>;
}

export interface McpJsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: McpJsonRpcErrorObject;
}

export interface McpContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface McpRawToolResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export type McpResultSource = "structuredContent" | "content";

export interface McpToolCallResult<T = unknown> {
  data: T;
  source: McpResultSource;
  schemaHash: string;
  raw: McpRawToolResult;
}

export type McpCallKind = "read" | "mutation";

export interface McpToolCallOptions {
  kind: McpCallKind;
  /** Pins a read adapter to the contract it has reviewed. */
  expectedSchemaHash?: string;
  signal?: AbortSignal;
}

export const MCP_ERROR_CODES = [
  "INVALID_CONFIGURATION",
  "INVALID_SCOPE",
  "OAUTH_CREDENTIAL_MISSING",
  "OAUTH_REFRESH_FAILED",
  "TRANSPORT_FAILURE",
  "REQUEST_TIMEOUT",
  "REQUEST_CANCELLED",
  "HTTP_FAILURE",
  "AUTHENTICATION_REQUIRED",
  "RATE_LIMITED",
  "STALE_SESSION",
  "PROTOCOL_ERROR",
  "REMOTE_ERROR",
  "TOOL_NOT_FOUND",
  "ARGUMENT_VALIDATION_FAILED",
  "SCHEMA_UNSUPPORTED",
  "SCHEMA_MISMATCH",
  "SCHEMA_PERSISTENCE_FAILED",
  "MUTATION_DISABLED",
  "CONTRACT_DISCOVERY_REQUIRED",
  "MUTATION_TOOL_NOT_APPROVED",
  "TOOL_EXECUTION_FAILED",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export interface McpErrorOptions {
  providerCode?: string | number;
  rpcCode?: number;
  httpStatus?: number;
  retryAfterMs?: number;
  retryable?: boolean;
  /** True only when a mutation may have reached the provider. */
  outcomeUnknown?: boolean;
  cause?: unknown;
}

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly providerCode?: string | number;
  readonly rpcCode?: number;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  override readonly cause?: unknown;

  constructor(code: McpErrorCode, message: string, options: McpErrorOptions = {}) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.providerCode = options.providerCode;
    this.rpcCode = options.rpcCode;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.cause = options.cause;
  }
}

export function isMcpError(error: unknown): error is McpError {
  return error instanceof McpError;
}
