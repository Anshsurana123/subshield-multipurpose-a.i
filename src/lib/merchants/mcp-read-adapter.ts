import { McpClient } from "../mcp/client";
import {
  McpError,
  type McpResultSource,
  type McpSchemaSnapshot,
  type McpSessionScope,
  type McpToolDefinition,
} from "../mcp/types";

export interface ApprovedMerchantReadContract {
  /** Exact hash from a reviewed, sanitized tools/list fixture. */
  schemaHash: string;
  /** Only tools confirmed during review to be side-effect free. */
  approvedToolNames: readonly string[];
}

export interface MerchantContractDiscovery {
  provider: string;
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  schemaHash: string;
  tools: readonly McpToolDefinition[];
}

export interface MerchantReadOutcome<T = unknown> {
  ok: true;
  provider: string;
  toolName: string;
  schemaHash: string;
  source: McpResultSource;
  data: T;
}

function validateReadContract(contract: ApprovedMerchantReadContract): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(contract.schemaHash)) {
    throw new McpError(
      "CONTRACT_DISCOVERY_REQUIRED",
      "The merchant read contract must pin an exact tools/list hash.",
    );
  }
  if (
    contract.approvedToolNames.length === 0 ||
    new Set(contract.approvedToolNames).size !== contract.approvedToolNames.length ||
    contract.approvedToolNames.some(
      (name) =>
        !name || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name),
    )
  ) {
    throw new McpError(
      "CONTRACT_DISCOVERY_REQUIRED",
      "The merchant read contract contains no valid audited tool allowlist.",
    );
  }
}

/**
 * Discovery is always available. Tool invocation is unavailable until a
 * reviewed contract explicitly pins both the full schema hash and read-only
 * tool names. This class deliberately exposes no mutation API.
 */
export abstract class MerchantMcpReadAdapter {
  protected constructor(
    private readonly client: McpClient,
    protected readonly scope: McpSessionScope,
    private readonly contract?: ApprovedMerchantReadContract,
  ) {
    if (contract) validateReadContract(contract);
  }

  async discoverContract(signal?: AbortSignal): Promise<MerchantContractDiscovery> {
    const snapshot = await this.client.discoverTools(this.scope, signal);
    return this.toDiscovery(snapshot);
  }

  async callReadTool<T = unknown>(
    toolName: string,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MerchantReadOutcome<T>> {
    if (!this.contract) {
      throw new McpError(
        "CONTRACT_DISCOVERY_REQUIRED",
        "Merchant reads remain disabled until tools/list has been reviewed.",
      );
    }
    if (!this.contract.approvedToolNames.includes(toolName)) {
      throw new McpError(
        "MUTATION_TOOL_NOT_APPROVED",
        "The requested merchant tool is not approved as read-only.",
      );
    }

    const result = await this.client.callTool<T>(
      this.scope,
      toolName,
      argumentsValue,
      {
        kind: "read",
        expectedSchemaHash: this.contract.schemaHash,
        signal,
      },
    );
    return {
      ok: true,
      provider: this.scope.provider,
      toolName,
      schemaHash: result.schemaHash,
      source: result.source,
      data: result.data,
    };
  }

  private toDiscovery(snapshot: McpSchemaSnapshot): MerchantContractDiscovery {
    return {
      provider: this.scope.provider,
      protocolVersion: snapshot.protocolVersion,
      serverName: snapshot.serverInfo.name,
      serverVersion: snapshot.serverInfo.version,
      schemaHash: snapshot.schemaHash,
      tools: snapshot.tools,
    };
  }
}
