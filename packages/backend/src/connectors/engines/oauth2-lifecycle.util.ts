import { Logger } from '@nestjs/common';
import axios, { Method } from 'axios';
import { PrismaService } from '../../common/prisma.service';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { usesBasicTokenAuth, buildBasicTokenAuthHeader } from './oauth2-token.service';

/**
 * Best-effort OAuth2 token revocation (RFC 7009). Adapters opt in by setting
 * `authConfig.revocationUrl` (e.g. DATEV's interface requirements mandate
 * calling it when the user disconnects); adapters without it are a no-op —
 * no behavior change for the other 175+ connectors.
 *
 * Never throws: a disconnect must always succeed locally even if the
 * provider's revocation endpoint is unreachable or rejects the call.
 */
export async function revokeOAuth2Token(
  authConfig: Record<string, unknown>,
  logger: Logger,
): Promise<void> {
  const revocationUrl = authConfig.revocationUrl ? String(authConfig.revocationUrl) : '';
  const refreshToken = authConfig.refreshToken ? String(authConfig.refreshToken) : '';
  if (!revocationUrl || !refreshToken) return;

  try {
    await assertSafeOutboundUrl(revocationUrl);

    const clientId = authConfig.clientId ? String(authConfig.clientId) : undefined;
    const clientSecret = authConfig.clientSecret ? String(authConfig.clientSecret) : undefined;
    const tokenAuthMethod = String(authConfig.tokenAuthMethod || 'body');

    const body: Record<string, string> = {
      token: refreshToken,
      token_type_hint: 'refresh_token',
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (usesBasicTokenAuth(tokenAuthMethod) && clientId && clientSecret) {
      headers.Authorization = buildBasicTokenAuthHeader(clientId, clientSecret);
    } else {
      if (clientId) body.client_id = clientId;
      if (clientSecret) body.client_secret = clientSecret;
    }

    await axios.post(revocationUrl, new URLSearchParams(body).toString(), {
      headers,
      timeout: 10000,
    });
    logger.debug(`OAuth2: revoked refresh token at ${revocationUrl}`);
  } catch (err: any) {
    logger.warn(
      `OAuth2: token revocation at ${revocationUrl} failed (continuing with local disconnect): ${err.message}`,
    );
  }
}

/** Revoke both token types when a provider-side entitlement check fails. */
export async function revokeOAuth2Tokens(
  authConfig: Record<string, unknown>,
  logger: Logger,
  tokens: { accessToken?: string; refreshToken?: string },
): Promise<void> {
  const revocationUrl = authConfig.revocationUrl ? String(authConfig.revocationUrl) : '';
  if (!revocationUrl) return;

  const clientId = authConfig.clientId ? String(authConfig.clientId) : undefined;
  const clientSecret = authConfig.clientSecret ? String(authConfig.clientSecret) : undefined;
  const tokenAuthMethod = String(authConfig.tokenAuthMethod || 'body');

  for (const [token, hint] of [
    [tokens.accessToken, 'access_token'],
    [tokens.refreshToken, 'refresh_token'],
  ] as const) {
    if (!token) continue;
    try {
      await assertSafeOutboundUrl(revocationUrl);
      const body: Record<string, string> = { token, token_type_hint: hint };
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (usesBasicTokenAuth(tokenAuthMethod) && clientId && clientSecret) {
        headers.Authorization = buildBasicTokenAuthHeader(clientId, clientSecret);
      } else {
        if (clientId) body.client_id = clientId;
        if (clientSecret) body.client_secret = clientSecret;
      }
      await axios.post(revocationUrl, new URLSearchParams(body).toString(), {
        headers,
        timeout: 10000,
      });
      logger.debug(`OAuth2: revoked ${hint} at ${revocationUrl}`);
    } catch (err: any) {
      logger.warn(`OAuth2: ${hint} revocation at ${revocationUrl} failed: ${err.message}`);
    }
  }
}

/**
 * Best-effort post-authorization enrichment for adapters that declare
 * `userinfoUrl` and/or `postAuthVerifyTool` — surfaces the info DATEV's
 * connection-status UI requires (the authorizing user's name, confirmation
 * that access to the underlying dataset was actually granted). Adapters
 * without these fields get an empty result; never throws — a failure here
 * must never undo an OAuth grant that already succeeded.
 */
export async function enrichAfterAuth(params: {
  prisma: PrismaService;
  logger: Logger;
  connectorId: string;
  accessToken: string;
  userinfoUrl?: string;
  postAuthVerifyTool?: string;
  staticHeaders?: Record<string, string>;
  requiredEntitlement?: {
    serviceName: string;
    revokeOnFailure?: boolean;
    orderUrl?: string;
  };
  tokenConfig?: Record<string, unknown>;
  refreshToken?: string;
}): Promise<{ issuedToName?: string; verifiedDatasetLabel?: string }> {
  const {
    prisma,
    logger,
    connectorId,
    accessToken,
    userinfoUrl,
    postAuthVerifyTool,
    staticHeaders,
    requiredEntitlement,
    tokenConfig,
    refreshToken,
  } = params;
  const result: { issuedToName?: string; verifiedDatasetLabel?: string } = {};

  if (userinfoUrl) {
    try {
      await assertSafeOutboundUrl(userinfoUrl);
      const res = await axios.get(userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      });
      const info = (res.data || {}) as Record<string, unknown>;
      const cleanPart = (value: unknown) => {
        const text = String(value ?? '').trim();
        if (!text || /^null$/i.test(text) || /^undefined$/i.test(text)) return '';
        const cleaned = text
          .split(/\s+/)
          .filter((part) => !/^null$/i.test(part) && !/^undefined$/i.test(part))
          .join(' ')
          .trim();
        return cleaned;
      };
      const fullName = [cleanPart(info.given_name), cleanPart(info.family_name)]
        .filter(Boolean)
        .join(' ');
      const suppliedName = cleanPart(info.name);
      const name = suppliedName || fullName || cleanPart(info.sub);
      if (name) result.issuedToName = name;
    } catch (err: any) {
      logger.warn(`OAuth2: userinfo lookup at ${userinfoUrl} failed: ${err.message}`);
    }
  }

  if (postAuthVerifyTool) {
    try {
      const tool = await prisma.mcpTool.findFirst({
        where: { connectorId, name: postAuthVerifyTool },
      });
      const mapping = tool?.endpointMapping as
        | { method?: string; path?: string; headers?: Record<string, string> }
        | undefined;
      if (mapping?.path) {
        await assertSafeOutboundUrl(mapping.path);
        const res = await axios.request({
          method: (mapping.method || 'GET') as Method,
          url: mapping.path,
          headers: {
            ...staticHeaders,
            ...mapping.headers,
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 10000,
        });
        const data = res.data as unknown;
        const list = Array.isArray(data)
          ? data
          : Array.isArray((data as Record<string, unknown>)?.clients)
            ? ((data as Record<string, unknown>).clients as unknown[])
            : Array.isArray((data as Record<string, unknown>)?.items)
              ? ((data as Record<string, unknown>).items as unknown[])
              : undefined;
        if (requiredEntitlement) {
          const serviceName = requiredEntitlement.serviceName;
          const entitledItems = list?.filter((item) => {
            const services = (item as Record<string, unknown>)?.services;
            return Array.isArray(services) && services.some((service) => {
              if (typeof service === 'string') return service === serviceName;
              return String((service as Record<string, unknown>)?.name ||
                (service as Record<string, unknown>)?.displayName || '') === serviceName;
            });
          }) ?? [];
          const entitled = entitledItems.length > 0;
          if (!entitled) {
            if (requiredEntitlement.revokeOnFailure !== false && tokenConfig) {
              await revokeOAuth2Tokens(tokenConfig, logger, { accessToken, refreshToken });
            }
            throw new Error(
              `DATEV entitlement missing: ${serviceName}. The authorization was revoked. ` +
                'Order or enable the required DATEV service before retrying.' +
                (requiredEntitlement.orderUrl ? ` See: ${requiredEntitlement.orderUrl}` : ''),
            );
          }
          const ids = entitledItems
            .map((item) => {
              const record = item as Record<string, unknown>;
              return record.clientId || record.client_id || record.id;
            })
            .filter(Boolean)
            .map(String);
          result.verifiedDatasetLabel = ids.length
            ? `${serviceName} enabled for client-id(s): ${ids.join(', ')}`
            : `${serviceName} enabled`;
        } else {
          result.verifiedDatasetLabel = list
            ? `Access confirmed — ${list.length} record(s)`
            : 'Access confirmed';
        }
      } else if (requiredEntitlement) {
        if (requiredEntitlement.revokeOnFailure !== false && tokenConfig) {
          await revokeOAuth2Tokens(tokenConfig, logger, { accessToken, refreshToken });
        }
        throw new Error(
          `DATEV entitlement check could not run because verification tool ` +
            `${postAuthVerifyTool} is not configured. The authorization was revoked.`,
        );
      }
    } catch (err: any) {
      logger.warn(`OAuth2: post-auth verify call (${postAuthVerifyTool}) failed: ${err.message}`);
      if (
        requiredEntitlement &&
        /^DATEV entitlement (missing:|check could not run)/.test(String(err.message))
      ) {
        throw err;
      }
    }
  }

  return result;
}
