import { createHash } from "node:crypto";

import { mcpScopeKey } from "./session.ts";
import {
  McpError,
  type JsonSchema,
  type McpSchemaSnapshot,
  type McpSchemaSnapshotStore,
  type McpServerInfo,
  type McpSessionScope,
  type McpToolDefinition,
} from "./types.ts";

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new McpError(
          "PROTOCOL_ERROR",
          "MCP tool schemas must contain finite JSON numbers.",
        );
      }
      return JSON.stringify(value);
    case "object": {
      if (seen.has(value)) {
        throw new McpError(
          "PROTOCOL_ERROR",
          "MCP tool schemas must not contain circular values.",
        );
      }

      seen.add(value);
      let encoded: string;
      if (Array.isArray(value)) {
        encoded = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
      } else {
        const record = value as Record<string, unknown>;
        const fields = Object.keys(record)
          .sort()
          .map((key) => {
            const field = record[key];
            if (field === undefined) {
              throw new McpError(
                "PROTOCOL_ERROR",
                "MCP tool schemas must not contain undefined values.",
              );
            }
            return `${JSON.stringify(key)}:${canonicalJson(field, seen)}`;
          });
        encoded = `{${fields.join(",")}}`;
      }
      seen.delete(value);
      return encoded;
    }
    default:
      throw new McpError(
        "PROTOCOL_ERROR",
        "MCP tool schemas must contain JSON values only.",
      );
  }
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return (
    typeof value === "boolean" ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  );
}

function normalizeTool(value: unknown): McpToolDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "tools/list returned a non-object tool definition.",
    );
  }

  const tool = value as Record<string, unknown>;
  if (
    typeof tool.name !== "string" ||
    tool.name.length === 0 ||
    tool.name.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(tool.name)
  ) {
    throw new McpError(
      "PROTOCOL_ERROR",
      "tools/list returned an invalid tool name.",
    );
  }

  if (!isJsonSchema(tool.inputSchema)) {
    throw new McpError(
      "PROTOCOL_ERROR",
      `Tool ${tool.name} did not include a valid inputSchema.`,
    );
  }

  if (
    tool.description !== undefined &&
    typeof tool.description !== "string"
  ) {
    throw new McpError(
      "PROTOCOL_ERROR",
      `Tool ${tool.name} returned a non-string description.`,
    );
  }

  // Canonicalization validates that provider extensions are JSON-safe. The
  // structured clone keeps descriptions, schemas, annotations, and extensions.
  canonicalJson(tool);
  return structuredClone(tool) as McpToolDefinition;
}

export function stableToolSchemaHash(
  tools: readonly McpToolDefinition[],
): string {
  const ordered = [...tools].sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
  const digest = createHash("sha256")
    .update(canonicalJson(ordered), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export interface RegisterMcpSchemaInput {
  scope: Readonly<McpSessionScope>;
  protocolVersion: string;
  serverInfo: McpServerInfo;
  tools: readonly unknown[];
}

export class McpSchemaRegistry {
  constructor(private readonly store: McpSchemaSnapshotStore) {}

  async register(input: RegisterMcpSchemaInput): Promise<McpSchemaSnapshot> {
    const tools = input.tools.map(normalizeTool).sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    );
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) {
        throw new McpError(
          "PROTOCOL_ERROR",
          `tools/list returned duplicate tool ${tool.name}.`,
        );
      }
      names.add(tool.name);
    }

    const snapshot: McpSchemaSnapshot = {
      scope: { ...input.scope },
      protocolVersion: input.protocolVersion,
      serverInfo: structuredClone(input.serverInfo),
      schemaHash: stableToolSchemaHash(tools),
      discoveredAt: new Date().toISOString(),
      tools,
    };

    try {
      await this.store.save(snapshot);
    } catch (cause) {
      throw new McpError(
        "SCHEMA_PERSISTENCE_FAILED",
        "The discovered MCP contract could not be persisted.",
        { cause },
      );
    }

    return snapshot;
  }
}

/** Useful for tests and isolated discovery jobs; production should inject a durable store. */
export class InMemoryMcpSchemaSnapshotStore
  implements McpSchemaSnapshotStore
{
  private readonly snapshots = new Map<string, McpSchemaSnapshot>();

  async save(snapshot: Readonly<McpSchemaSnapshot>): Promise<void> {
    this.snapshots.set(
      mcpScopeKey(snapshot.scope),
      structuredClone(snapshot) as McpSchemaSnapshot,
    );
  }

  get(scope: Readonly<McpSessionScope>): McpSchemaSnapshot | undefined {
    const snapshot = this.snapshots.get(mcpScopeKey(scope));
    return snapshot
      ? (structuredClone(snapshot) as McpSchemaSnapshot)
      : undefined;
  }
}
