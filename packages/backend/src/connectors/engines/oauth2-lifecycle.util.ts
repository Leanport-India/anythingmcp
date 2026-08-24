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
}): Promise<{ issuedToName?: string; verifiedDatasetLabel?: string }> {
  const { prisma, logger, connectorId, accessToken, userinfoUrl, postAuthVerifyTool, staticHeaders } = params;
  const result: { issuedToName?: string; verifiedDatasetLabel?: string } = {};

  if (userinfoUrl) {
    try {
      await assertSafeOutboundUrl(userinfoUrl);
      const res = await axios.get(userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      });
      const info = (res.data || {}) as Record<string, unknown>;
      const fullName = [info.given_name, info.family_name].filter(Boolean).join(' ');
      const name = String(info.name || fullName || info.sub || '');
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
        result.verifiedDatasetLabel = list
          ? `Access confirmed — ${list.length} record(s)`
          : 'Access confirmed';
      }
    } catch (err: any) {
      logger.warn(`OAuth2: post-auth verify call (${postAuthVerifyTool}) failed: ${err.message}`);
    }
  }

  return result;
}
