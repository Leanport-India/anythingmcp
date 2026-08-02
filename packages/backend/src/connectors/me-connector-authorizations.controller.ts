import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Req,
  UseGuards,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ConnectorAuthorizationsService } from './connector-authorizations.service';
import { ConnectorsService } from './connectors.service';
import { McpOAuthService } from './mcp-oauth.service';
import { ConnectorAuthMode } from '../generated/prisma/client';

/**
 * End-user "My Connections" surface. Unlike ConnectorsController, this never
 * exposes connector internals (base URL, headers, auth config) — only what a
 * user needs to see and act on their own assigned connectors.
 */
@ApiTags('My Connections')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/me/connector-authorizations')
export class MeConnectorAuthorizationsController {
  private readonly logger = new Logger(MeConnectorAuthorizationsController.name);

  constructor(
    private readonly connectorAuth: ConnectorAuthorizationsService,
    private readonly connectorsService: ConnectorsService,
    private readonly mcpOAuthService: McpOAuthService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List connectors assigned to the current user' })
  async list(@Req() req: any) {
    return this.connectorAuth.listForUser(req.user.sub, req.user.organizationId);
  }

  @Post(':connectorId/oauth/authorize')
  @ApiOperation({
    summary: 'Start (or retry) OAuth2 authorization for an assigned PER_USER connector',
    description:
      'The resulting token belongs only to the current user. Fails if the ' +
      'connector is not assigned to this user, or is not a PER_USER connector.',
  })
  async authorize(@Req() req: any, @Param('connectorId') connectorId: string) {
    await this.connectorAuth.assertAssigned(connectorId, req.user.sub, req.user.organizationId);

    const connector = await this.connectorsService.findByIdInternal(connectorId);
    if (connector.organizationId !== req.user.organizationId) {
      throw new NotFoundException('Connector not found');
    }
    if (connector.authMode !== ConnectorAuthMode.PER_USER) {
      throw new BadRequestException(
        'This connector uses a shared authorization managed by your administrator',
      );
    }
    if (connector.authType !== 'OAUTH2') {
      throw new BadRequestException('Connector auth type must be OAUTH2');
    }

    const authConfig = this.connectorsService.getDecryptedAuthConfig(connector) || {};
    const callbackUrl = `${this.configService.get('SERVER_URL') || 'http://localhost:4000'}/api/mcp-oauth/callback`;

    let authorizationEndpoint: string;
    let tokenEndpoint: string;
    let scope: string | undefined;
    let clientId: string;
    let clientSecret: string | undefined;
    let tokenAuthMethod: string | undefined;

    if (connector.type === 'MCP') {
      const metadata = await this.mcpOAuthService.discoverMetadata(connector.baseUrl);
      authorizationEndpoint = metadata.authorization_endpoint;
      tokenEndpoint = metadata.token_endpoint;
      scope = metadata.scopes_supported?.join(' ');
      clientId = String(authConfig.clientId || '');
      clientSecret = authConfig.clientSecret ? String(authConfig.clientSecret) : undefined;
    } else {
      clientId = String(authConfig.clientId || '');
      clientSecret = authConfig.clientSecret ? String(authConfig.clientSecret) : undefined;
      authorizationEndpoint = String(authConfig.authorizationUrl || '');
      tokenEndpoint = String(authConfig.tokenUrl || '');
      scope = authConfig.scopes ? String(authConfig.scopes) : undefined;
      tokenAuthMethod = authConfig.tokenAuthMethod ? String(authConfig.tokenAuthMethod) : undefined;
    }

    if (!clientId || !authorizationEndpoint) {
      throw new BadRequestException(
        'This connector is not fully configured yet — ask your administrator to finish setup',
      );
    }

    const codeVerifier = this.mcpOAuthService.generateCodeVerifier();
    const codeChallenge = this.mcpOAuthService.generateCodeChallenge(codeVerifier);
    const state = this.mcpOAuthService.generateState();

    this.mcpOAuthService.storePendingFlow(state, {
      codeVerifier,
      connectorId: connector.id,
      userId: req.user.sub,
      redirectUri: callbackUrl,
      clientId,
      clientSecret,
      tokenAuthMethod,
      tokenUrl: tokenEndpoint,
      createdAt: Date.now(),
      perUser: true,
    });

    const authorizationUrl = this.mcpOAuthService.buildAuthorizationUrl({
      authorizationEndpoint,
      clientId,
      redirectUri: callbackUrl,
      codeChallenge,
      state,
      scope,
    });

    return { authorizationUrl };
  }

  @Delete(':connectorId')
  @ApiOperation({ summary: "Revoke the current user's own authorization for a connector" })
  async revoke(@Req() req: any, @Param('connectorId') connectorId: string) {
    await this.connectorAuth.assertAssigned(connectorId, req.user.sub, req.user.organizationId);
    await this.connectorAuth.revokeUserCredential(connectorId, req.user.sub);
    return { success: true };
  }
}
