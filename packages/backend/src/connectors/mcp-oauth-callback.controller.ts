import { Controller, Get, Query, Res, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { McpOAuthService } from './mcp-oauth.service';
import { ConnectorsService } from './connectors.service';
import { ConnectorAuthorizationsService } from './connector-authorizations.service';
import { McpClientEngine } from './engines/mcp-client.engine';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';

/**
 * Separate controller for the OAuth2 callback — no JWT guard.
 * The remote MCP server redirects the user's browser here after login.
 */
@ApiTags('MCP OAuth')
@Controller('api/mcp-oauth')
export class McpOAuthCallbackController {
  private readonly logger = new Logger(McpOAuthCallbackController.name);

  constructor(
    private readonly mcpOAuthService: McpOAuthService,
    private readonly connectorsService: ConnectorsService,
    private readonly connectorAuth: ConnectorAuthorizationsService,
    private readonly mcpClientEngine: McpClientEngine,
    private readonly prisma: PrismaService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
  ) {}

  @Get('callback')
  @ApiOperation({
    summary: 'OAuth2 callback handler for MCP connector authorization',
    description:
      'Handles the redirect from a remote MCP server after user authorization. ' +
      'Exchanges the auth code for tokens and auto-discovers MCP tools.',
  })
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

    if (!code || !state) {
      return res.redirect(
        `${frontendUrl}/connectors?error=${encodeURIComponent('Missing code or state in OAuth callback')}`,
      );
    }

    const flow = this.mcpOAuthService.getPendingFlow(state);
    if (!flow) {
      this.logger.warn(`OAuth callback with unknown state: ${state}`);
      return res.redirect(
        `${frontendUrl}/connectors?error=${encodeURIComponent('OAuth session expired or invalid state')}`,
      );
    }

    try {
      // 1. Exchange auth code for tokens
      const tokens = await this.mcpOAuthService.exchangeCodeForTokens({
        tokenUrl: flow.tokenUrl,
        code,
        redirectUri: flow.redirectUri,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        tokenAuthMethod: flow.tokenAuthMethod,
        codeVerifier: flow.codeVerifier,
      });

      this.logger.log(
        `OAuth tokens obtained for connector ${flow.connectorId}`,
      );

      if (flow.perUser) {
        // Per-user grant: the token belongs only to flow.userId and is
        // stored separately from the connector's shared authConfig. Other
        // users' access to this connector (or the connector's own shared
        // credential, if any) is untouched.
        const existingConnector = await this.connectorsService.findByIdInternal(
          flow.connectorId,
        );

        await this.connectorAuth.saveUserCredential(
          flow.connectorId,
          flow.userId,
          existingConnector.organizationId,
          {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            tokenUrl: flow.tokenUrl,
            clientId: flow.clientId,
            clientSecret: flow.clientSecret,
            tokenAuthMethod: flow.tokenAuthMethod,
            expiresIn: tokens.expiresIn,
            expiresAt: Date.now() + (tokens.expiresIn || 3600) * 1000,
            authorizedAt: new Date().toISOString(),
          },
        );

        this.mcpOAuthService.deletePendingFlow(state);
        return res.redirect(`${frontendUrl}/connections?oauth=success`);
      }

      // 2. Store tokens (encrypted) in the connector's authConfig.
      // Preserve static OAuth settings (authorizationUrl, scopes, auth method)
      // so a successful callback does not make later re-authorization impossible.
      const existingConnector = await this.connectorsService.findByIdInternal(
        flow.connectorId,
      );
      const existingAuthConfig =
        this.connectorsService.getDecryptedAuthConfig(existingConnector) || {};

      await this.connectorsService.update(
        flow.connectorId,
        {
          authConfig: {
            ...existingAuthConfig,
            accessToken: tokens.accessToken,
            refreshToken:
              tokens.refreshToken || existingAuthConfig.refreshToken,
            tokenUrl: flow.tokenUrl,
            clientId: flow.clientId,
            clientSecret: flow.clientSecret,
            tokenAuthMethod:
              flow.tokenAuthMethod || existingAuthConfig.tokenAuthMethod,
            expiresIn: tokens.expiresIn,
            expiresAt: Date.now() + (tokens.expiresIn || 3600) * 1000,
            authorizedAt: new Date().toISOString(),
          },
        },
      );

      // Reload the connector's tools into the in-memory MCP registry so the
      // freshly stored access token takes effect immediately.
      try {
        await this.mcpServer.reloadConnectorTools(flow.connectorId);
      } catch (reloadErr: any) {
        this.logger.warn(
          `Failed to reload tools after OAuth for connector ${flow.connectorId}: ${reloadErr.message}`,
        );
      }

      // 3. Auto-discover tools from the remote MCP server
      let toolsImported = 0;
      try {
        const connector = await this.connectorsService.findByIdInternal(
          flow.connectorId,
        );

        const remoteTools = await this.mcpClientEngine.listTools({
          baseUrl: connector.baseUrl,
          authType: 'OAUTH2',
          authConfig: {
            accessToken: tokens.accessToken,
          },
          headers: connector.headers as Record<string, string>,
        });

        for (const rt of remoteTools) {
          try {
            await this.prisma.mcpTool.create({
              data: {
                connectorId: flow.connectorId,
                name: rt.name,
                description: rt.description || `MCP tool: ${rt.name}`,
                parameters: rt.inputSchema as any,
                endpointMapping: {
                  method: rt.name,
                  path: '/mcp',
                } as any,
                // The upstream server is authoritative about its own tools.
                annotations: (rt.annotations ?? null) as any,
              },
            });
            toolsImported++;
          } catch (err: any) {
            // Skip duplicates
            if (err.code !== 'P2002') {
              this.logger.warn(
                `Failed to import tool ${rt.name}: ${err.message}`,
              );
            }
          }
        }

        await this.mcpServer.reloadConnectorTools(flow.connectorId);

        this.logger.log(
          `Auto-discovered ${toolsImported} tools for connector ${flow.connectorId}`,
        );
      } catch (discoverErr: any) {
        this.logger.warn(
          `Tool discovery failed after OAuth (will proceed anyway): ${discoverErr.message}`,
        );
      }

      // 4. Clean up
      this.mcpOAuthService.deletePendingFlow(state);

      // 5. Redirect to frontend
      return res.redirect(
        `${frontendUrl}/connectors/${flow.connectorId}?oauth=success&tools=${toolsImported}`,
      );
    } catch (error: any) {
      const providerStatus = error?.response?.status;
      const providerData = error?.response?.data;
      this.logger.error(
        `OAuth callback failed for connector ${flow.connectorId}: ${error.message}` +
          (providerStatus ? ` providerStatus=${providerStatus}` : '') +
          (providerData
            ? ` providerResponse=${JSON.stringify(providerData)}`
            : ''),
      );
      if (flow.perUser) {
        try {
          const connector = await this.connectorsService.findByIdInternal(flow.connectorId);
          await this.connectorAuth.recordUserAuthError(
            flow.connectorId,
            flow.userId,
            connector.organizationId,
            error.message,
          );
        } catch {
          // Best-effort — the redirect below still informs the user.
        }
      }
      this.mcpOAuthService.deletePendingFlow(state);
      return res.redirect(
        flow.perUser
          ? `${frontendUrl}/connections?oauth=error&message=${encodeURIComponent(error.message)}`
          : `${frontendUrl}/connectors/${flow.connectorId}?oauth=error&message=${encodeURIComponent(error.message)}`,
      );
    }
  }
}
