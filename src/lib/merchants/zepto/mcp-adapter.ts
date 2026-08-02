import { McpClient } from "../../mcp/client";
import {
  MerchantMcpReadAdapter,
  type ApprovedMerchantReadContract,
} from "../mcp-read-adapter";

export interface ZeptoMcpReadAdapterOptions {
  client: McpClient;
  userId: string;
  merchantConnectionId: string;
  /** Omit until the sanitized Zepto contract fixture has been reviewed. */
  contract?: ApprovedMerchantReadContract;
}

/** Read-only Zepto MCP access; no order or payment payloads are implemented. */
export class ZeptoMcpReadAdapter extends MerchantMcpReadAdapter {
  constructor(options: ZeptoMcpReadAdapterOptions) {
    super(
      options.client,
      {
        userId: options.userId,
        provider: "zepto",
        merchantConnectionId: options.merchantConnectionId,
      },
      options.contract,
    );
  }
}
