import productionAdapter from './datev.json';
import sandboxAdapter from './datev-sandbox.json';

type DatevAdapter = {
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
  };
  tools: Array<{
    name: string;
    endpointMapping: { path: string };
  }>;
};

const production = productionAdapter as unknown as DatevAdapter;
const sandbox = sandboxAdapter as unknown as DatevAdapter;

describe('DATEV sandbox adapter', () => {
  it('uses OAuth2 client_secret_basic token endpoint auth', () => {
    expect(sandbox.connector.authType).toBe('OAUTH2');
    expect(sandbox.connector.authConfig.tokenAuthMethod).toBe(
      'client_secret_basic',
    );
  });

  it('pins OAuth endpoints to DATEV sandbox', () => {
    expect(sandbox.connector.authConfig.authorizationUrl).toBe(
      'https://login.datev.de/openidsandbox/authorize',
    );
    expect(sandbox.connector.authConfig.tokenUrl).toBe(
      'https://sandbox-api.datev.de/token',
    );
  });

  it('pins connector and tool URLs to platform-sandbox paths', () => {
    expect(sandbox.connector.baseUrl).toBe(
      'https://accounting-clients.api.datev.de/platform-sandbox/v2',
    );

    for (const tool of sandbox.tools) {
      expect(tool.name).toMatch(/^datev_sandbox_/);
      expect(tool.endpointMapping.path).toMatch(
        /^https:\/\/(([a-z0-9-]+\.)?api\.datev\.de\/platform-sandbox\/v[123]|sandbox-api\.datev\.de\/userinfo)/,
      );
      expect(tool.endpointMapping.path).not.toContain('/platform/v2');
    }
  });

  it('keeps the production DATEV adapter on production endpoints', () => {
    expect(production.connector.authConfig.authorizationUrl).toBe(
      'https://login.datev.de/openid/authorize',
    );
    expect(production.connector.authConfig.tokenUrl).toBe(
      'https://api.datev.de/token',
    );
    expect(production.connector.baseUrl).toBe(
      'https://accounting-clients.api.datev.de/platform/v2',
    );
  });

  it('sends the mandatory DATEV client id header', () => {
    expect(sandbox.connector.headers['X-DATEV-Client-Id']).toBe(
      '{{DATEV_CLIENT_ID}}',
    );
  });
});
