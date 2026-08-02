import { McpClient } from "../../mcp/client";
import {
  MerchantMcpReadAdapter,
  type ApprovedMerchantReadContract,
} from "../mcp-read-adapter";

export interface SwiggyMcpReadAdapterOptions {
  client: McpClient;
  userId: string;
  merchantConnectionId: string;
  /** Omit until the sanitized Swiggy contract fixture has been reviewed. */
  contract?: ApprovedMerchantReadContract;
}

/** Read-only Swiggy MCP access; no order or payment payloads are implemented. */
export class SwiggyMcpReadAdapter extends MerchantMcpReadAdapter {
  constructor(options: SwiggyMcpReadAdapterOptions) {
    super(
      options.client,
      {
        userId: options.userId,
        provider: "swiggy",
        merchantConnectionId: options.merchantConnectionId,
      },
      options.contract,
    );
  }
}
