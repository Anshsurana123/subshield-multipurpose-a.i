import {
  McpError,
  type McpAccessToken,
  type McpOAuthCredentialProvider,
  type McpOAuthMetadata,
  type McpSessionScope,
} from "./types.ts";

export interface McpAuthorization {
  metadata: McpOAuthMetadata;
  authorizationHeader: string;
}

export interface McpOAuthManagerOptions {
  refreshSkewMs?: number;
  now?: () => number;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;

function validateToken(token: McpAccessToken): McpAccessToken {
  const value = token.accessToken;
  const tokenType = token.tokenType ?? "Bearer";

  if (!value || value.trim() !== value || /[\r\n]/u.test(value)) {
    throw new McpError(
      "OAUTH_CREDENTIAL_MISSING",
      "The merchant connection did not provide a usable access token.",
    );
  }

  if (!/^[A-Za-z][A-Za-z0-9._~-]*$/u.test(tokenType)) {
    throw new McpError(
      "OAUTH_CREDENTIAL_MISSING",
      "The merchant connection returned an invalid token type.",
    );
  }

  if (
    token.expiresAt !== undefined &&
    (!Number.isFinite(token.expiresAt) || token.expiresAt <= 0)
  ) {
    throw new McpError(
      "OAUTH_CREDENTIAL_MISSING",
      "The merchant connection returned an invalid token expiry.",
    );
  }

  return { ...token, tokenType };
}

/**
 * Resolves credentials for one explicit user/provider/connection scope.
 * The provider owns secure storage and refresh-token handling; this class never
 * reads merchant credentials from process-wide environment variables.
 */
export class McpOAuthManager {
  private readonly refreshSkewMs: number;
  private readonly now: () => number;

  constructor(
    private readonly provider: McpOAuthCredentialProvider,
    options: McpOAuthManagerOptions = {},
  ) {
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.now = options.now ?? Date.now;

    if (
      !Number.isFinite(this.refreshSkewMs) ||
      this.refreshSkewMs < 0 ||
      this.refreshSkewMs > 5 * 60_000
    ) {
      throw new McpError(
        "INVALID_CONFIGURATION",
        "OAuth refresh skew must be between zero and five minutes.",
      );
    }
  }

  async authorize(
    scope: Readonly<McpSessionScope>,
    options: { forceRefresh?: boolean } = {},
  ): Promise<McpAuthorization> {
    let metadata: McpOAuthMetadata;

    try {
      metadata = await this.provider.resolveMetadata(scope);
    } catch (cause) {
      throw new McpError(
        "OAUTH_CREDENTIAL_MISSING",
        "Unable to resolve OAuth metadata for this merchant connection.",
        { cause },
      );
    }

    let token: McpAccessToken | null = null;

    if (!options.forceRefresh) {
      try {
        token = await this.provider.loadAccessToken(scope, metadata);
      } catch (cause) {
        throw new McpError(
          "OAUTH_CREDENTIAL_MISSING",
          "Unable to load OAuth credentials for this merchant connection.",
          { cause },
        );
      }
    }

    const needsRefresh =
      options.forceRefresh === true ||
      token === null ||
      (token.expiresAt !== undefined &&
        token.expiresAt <= this.now() + this.refreshSkewMs);

    if (needsRefresh) {
      try {
        token = await this.provider.refreshAccessToken(scope, metadata);
      } catch (cause) {
        throw new McpError(
          "OAUTH_REFRESH_FAILED",
          "Unable to refresh OAuth credentials for this merchant connection.",
          { cause },
        );
      }
    }

    if (token === null) {
      throw new McpError(
        "OAUTH_CREDENTIAL_MISSING",
        "No OAuth credential is linked to this merchant connection.",
      );
    }

    const validToken = validateToken(token);
    return {
      metadata,
      authorizationHeader: `${validToken.tokenType} ${validToken.accessToken}`,
    };
  }
}
