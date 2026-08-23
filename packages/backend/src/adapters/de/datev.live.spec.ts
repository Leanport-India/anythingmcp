import adapter from './datev.json';

const a = adapter as unknown as {
  connector: {
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
  };
};

describe('DATEV adapter', () => {
  it('uses OAuth2 client_secret_basic token endpoint auth', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.tokenAuthMethod).toBe('client_secret_basic');
  });

  it('keeps canonical DATEV production endpoints in the default adapter', () => {
    expect(a.connector.authConfig.authorizationUrl).toBe(
      'https://login.datev.de/openid/authorize',
    );
    expect(a.connector.authConfig.tokenUrl).toBe('https://api.datev.de/token');
  });

  it('sends the mandatory DATEV client id header', () => {
    expect(a.connector.headers['X-DATEV-Client-Id']).toBe(
      '{{DATEV_CLIENT_ID}}',
    );
  });
});
