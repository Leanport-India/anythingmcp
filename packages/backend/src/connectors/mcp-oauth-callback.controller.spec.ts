import { McpOAuthCallbackController } from './mcp-oauth-callback.controller';

/**
 * Regression test for the REST OAuth reload gap: after a REST/GraphQL connector
 * completes the OAuth flow, the freshly-stored access token must be loaded into
 * the in-memory MCP registry. The MCP auto-discovery below throws for non-MCP
 * servers, so the reload must happen independently of it.
 */
function makeController(overrides: {
  listToolsThrows?: boolean;
} = {}) {
  const reloadConnectorTools = jest.fn().mockResolvedValue(undefined);
  const updateAuthConfigMerge = jest.fn().mockResolvedValue(undefined);
  const deletePendingFlow = jest.fn();

  const mcpOAuthService: any = {
    getPendingFlow: jest.fn().mockReturnValue({
      connectorId: 'conn-1',
      tokenUrl: 'https://sandbox-api.datev.de/token',
      redirectUri: 'https://cloud.example.com/api/mcp-oauth/callback',
      clientId: 'cid',
      clientSecret: 'sec',
      codeVerifier: 'verifier',
      tokenAuthMethod: 'basic',
    }),
    exchangeCodeForTokens: jest.fn().mockResolvedValue({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresIn: 3600,
    }),
    deletePendingFlow,
  };
  const connectorsService: any = {
    updateAuthConfigMerge,
    findByIdInternal: jest.fn().mockResolvedValue({
      baseUrl: 'https://accounting-clients.api.datev.de/platform-sandbox/v2',
      headers: {},
      organizationId: 'org-1',
    }),
    getDecryptedAuthConfig: jest.fn().mockReturnValue({}),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mcpClientEngine: any = {
    listTools: overrides.listToolsThrows
      ? jest.fn().mockRejectedValue(new Error('not an MCP server'))
      : jest.fn().mockResolvedValue([]),
  };
  const prisma: any = { mcpTool: { create: jest.fn() } };
  const mcpServer: any = { reloadConnectorTools };
  const configService: any = { get: jest.fn().mockReturnValue('https://cloud.example.com') };

  const connectorAuth: any = {
    saveUserCredential: jest.fn().mockResolvedValue(undefined),
    recordUserAuthError: jest.fn().mockResolvedValue(undefined),
  };

  const controller = new McpOAuthCallbackController(
    mcpOAuthService,
    connectorsService,
    connectorAuth,
    mcpClientEngine,
    prisma,
    mcpServer,
    configService,
  );
  return { controller, reloadConnectorTools, updateAuthConfigMerge, mcpOAuthService };
}

function makeRes() {
  return { redirect: jest.fn() } as any;
}

describe('McpOAuthCallbackController', () => {
  it('reloads connector tools after storing the token even when MCP discovery throws (REST connector)', async () => {
    const { controller, reloadConnectorTools, updateAuthConfigMerge } =
      makeController({ listToolsThrows: true });
    const res = makeRes();

    await controller.oauthCallback('the-code', 'the-state', res);

    // Token was persisted via a MERGE (preserves authorizationUrl/scopes)...
    expect(updateAuthConfigMerge).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ accessToken: 'AT', tokenAuthMethod: 'basic' }),
    );
    // ...and the registry was reloaded despite discovery throwing.
    expect(reloadConnectorTools).toHaveBeenCalledWith('conn-1');
    // Redirects to success.
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('oauth=success'),
    );
  });

  it('redirects with an error when code/state are missing', async () => {
    const { controller, reloadConnectorTools } = makeController();
    const res = makeRes();
    await controller.oauthCallback('', '', res);
    expect(reloadConnectorTools).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error='));
  });
});
