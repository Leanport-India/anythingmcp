import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import axios from 'axios';
import { assertSafeOutboundUrl } from '../common/ssrf.util';

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface PendingOAuthFlow {
  codeVerifier: string;
  connectorId: string;
  userId: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  tokenAuthMethod?: string;
  tokenUrl: string;
  createdAt: number;
  // When true, the resulting token belongs to `userId` alone (stored in
  // UserConnectorAuthorization) instead of the connector's shared authConfig.
  perUser?: boolean;
}

export interface OAuthScopeSelectionOption {
  id: string;
  label: string;
  description?: string;
  scopes: string[];
}

export interface OAuthScopeSelectionConfig {
  title?: string;
  description?: string;
  required?: boolean;
  options: OAuthScopeSelectionOption[];
}

/**
 * Resolve the scopes after an explicit customer selection.  The selection is
 * validated here (rather than trusting the browser) so the authorization URL
 * can never request scopes that were not declared by the connector.
 */
export function resolveOAuthScopes(
  configuredScopes: unknown,
  selectionConfig: unknown,
  selectedIds: unknown,
): string | undefined {
  const config = selectionConfig as OAuthScopeSelectionConfig | undefined;
  if (!config?.options?.length) return configuredScopes ? String(configuredScopes) : undefined;

  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    if (config.required !== false) {
      throw new Error('Select the DATEV data services you want to use before continuing.');
    }
    return configuredScopes ? String(configuredScopes) : undefined;
  }

  const selected = [...new Set(selectedIds.map(String))];
  const options = config.options.filter((option) => selected.includes(option.id));
  if (options.length !== selected.length) {
    throw new Error('The selected DATEV data service is not available for this connector.');
  }

  const allSelectableScopes = new Set(config.options.flatMap((option) => option.scopes));
  const baseScopes = String(configuredScopes || '')
    .split(/\s+/)
    .filter((scope) => scope && !allSelectableScopes.has(scope));
  const selectedScopes = [...new Set([...baseScopes, ...options.flatMap((option) => option.scopes)])];
  return selectedScopes.join(' ');
}

function usesBasicTokenAuth(method?: string): boolean {
  return method === 'basic' || method === 'client_secret_basic';
}

function buildBasicTokenAuthHeader(clientId: string, clientSecret: string): string {
  // OAuth2 client_secret_basic uses form-encoding before base64 (RFC 6749 §2.3.1).
  const user = encodeURIComponent(clientId);
  const pass = encodeURIComponent(clientSecret);
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger(McpOAuthService.name);

  // In-memory store for pending OAuth flows, keyed by state.
  // Entries auto-expire after 10 minutes.
  private pendingFlows = new Map<string, PendingOAuthFlow>();

  /**
   * Fetch OAuth Authorization Server Metadata (RFC 8414)
   * from a remote MCP server's .well-known endpoint.
   *
   * If the metadata contains endpoint URLs with a different origin than the
   * actual server (common misconfiguration), they are rebased automatically.
   */
  async discoverMetadata(baseUrl: string): Promise<OAuthMetadata> {
    const actualOrigin = new URL(baseUrl).origin;

    // Try the standard well-known path
    const metadataUrl = new URL(
      '/.well-known/oauth-authorization-server',
      baseUrl,
    ).toString();

    this.logger.debug(`Discovering OAuth metadata from ${metadataUrl}`);

    await assertSafeOutboundUrl(metadataUrl);
    const response = await axios.get(metadataUrl, { timeout: 10000 });
    const metadata: OAuthMetadata = response.data;

    // Rebase endpoint URLs if the remote server reports a different origin
    // (e.g. the server's OAUTH_SERVER_URL env var is misconfigured).
    const rebase = (endpoint: string): string => {
      try {
        const parsed = new URL(endpoint);
        if (parsed.origin !== actualOrigin) {
          this.logger.warn(
            `Rebasing OAuth endpoint from ${parsed.origin} → ${actualOrigin} (${parsed.pathname})`,
          );
          return `${actualOrigin}${parsed.pathname}${parsed.search}`;
        }
        return endpoint;
      } catch {
        return endpoint;
      }
    };

    metadata.issuer = rebase(metadata.issuer);
    metadata.authorization_endpoint = rebase(metadata.authorization_endpoint);
    metadata.token_endpoint = rebase(metadata.token_endpoint);
    if (metadata.registration_endpoint) {
      metadata.registration_endpoint = rebase(metadata.registration_endpoint);
    }

    return metadata;
  }

  /**
   * Register as an OAuth client via RFC 7591 Dynamic Client Registration.
   */
  async registerClient(
    registrationEndpoint: string,
    callbackUrl: string,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    this.logger.debug(
      `Registering OAuth client at ${registrationEndpoint}`,
    );

    await assertSafeOutboundUrl(registrationEndpoint);
    const response = await axios.post(
      registrationEndpoint,
      {
        client_name: 'AnythingMCP Bridge',
        redirect_uris: [callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      },
      { timeout: 10000 },
    );

    const clientId = response.data?.client_id;
    if (!clientId) {
      throw new Error(
        'Dynamic client registration failed: server did not return a client_id',
      );
    }

    return {
      clientId,
      clientSecret: response.data.client_secret,
    };
  }

  /**
   * Build the authorization URL with PKCE S256 challenge.
   */
  buildAuthorizationUrl(params: {
    authorizationEndpoint: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
    scope?: string;
  }): string {
    const url = new URL(params.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', params.state);
    if (params.scope) {
      url.searchParams.set('scope', params.scope);
    }
    return url.toString();
  }

  /**
   * Exchange an authorization code for tokens (with PKCE verifier).
   */
  async exchangeCodeForTokens(params: {
    tokenUrl: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    tokenAuthMethod?: string;
    codeVerifier: string;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    refreshTokenExpiresIn?: number;
    refreshTokenExpiresAt?: number;
    refreshTokenLifetimeDays?: number;
    refreshTokenType?: string;
  }> {
    const tokenAuthMethod = String(params.tokenAuthMethod || 'body');
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    };

    if (usesBasicTokenAuth(tokenAuthMethod) && params.clientSecret) {
      headers.Authorization = buildBasicTokenAuthHeader(
        params.clientId,
        params.clientSecret,
      );
    } else {
      body.client_id = params.clientId;
    }
    if (!usesBasicTokenAuth(tokenAuthMethod) && params.clientSecret) {
      body.client_secret = params.clientSecret;
    }

    this.logger.debug(`Exchanging auth code at ${params.tokenUrl}`);

    await assertSafeOutboundUrl(params.tokenUrl);
    const response = await axios.post(
      params.tokenUrl,
      new URLSearchParams(body).toString(),
      {
        headers,
        timeout: 10000,
      },
    );

    const data = response.data;
    if (data.error) {
      throw new Error(`Token exchange failed: ${data.error} — ${data.error_description || ''}`);
    }

    const refreshTokenExpiresIn = Number(data.refresh_token_expires_in);
    const rawRefreshTokenExpiresAt = data.refresh_token_expires_at;
    const numericRefreshTokenExpiresAt = Number(rawRefreshTokenExpiresAt);
    const parsedRefreshTokenExpiresAt =
      typeof rawRefreshTokenExpiresAt === 'string' && Number.isNaN(numericRefreshTokenExpiresAt)
        ? Date.parse(rawRefreshTokenExpiresAt)
        : numericRefreshTokenExpiresAt;
    const refreshTokenExpiresAt = Number.isFinite(parsedRefreshTokenExpiresAt) && parsedRefreshTokenExpiresAt > 0
      ? (parsedRefreshTokenExpiresAt < 1_000_000_000_000
        ? parsedRefreshTokenExpiresAt * 1000
        : parsedRefreshTokenExpiresAt)
      : undefined;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      ...(Number.isFinite(refreshTokenExpiresIn) && refreshTokenExpiresIn > 0
        ? {
            refreshTokenExpiresIn,
            refreshTokenLifetimeDays: refreshTokenExpiresIn / 86400,
            refreshTokenExpiresAt:
              refreshTokenExpiresAt || Date.now() + refreshTokenExpiresIn * 1000,
          }
        : refreshTokenExpiresAt
          ? { refreshTokenExpiresAt }
          : {}),
      ...(data.refresh_token_type ? { refreshTokenType: String(data.refresh_token_type) } : {}),
    };
  }

  // --- PKCE Helpers ---

  generateCodeVerifier(): string {
    return randomBytes(32).toString('base64url');
  }

  generateCodeChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  generateState(): string {
    return randomBytes(16).toString('hex');
  }

  // --- Pending Flow Storage ---

  storePendingFlow(state: string, data: PendingOAuthFlow): void {
    // Clean up expired entries (>10 min)
    const now = Date.now();
    for (const [key, flow] of this.pendingFlows) {
      if (now - flow.createdAt > 10 * 60 * 1000) {
        this.pendingFlows.delete(key);
      }
    }

    this.pendingFlows.set(state, data);
  }

  getPendingFlow(state: string): PendingOAuthFlow | undefined {
    const flow = this.pendingFlows.get(state);
    if (!flow) return undefined;

    // Check expiry
    if (Date.now() - flow.createdAt > 10 * 60 * 1000) {
      this.pendingFlows.delete(state);
      return undefined;
    }

    return flow;
  }

  deletePendingFlow(state: string): void {
    this.pendingFlows.delete(state);
  }
}
