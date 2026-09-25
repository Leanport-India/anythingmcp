import liveAdapter from './datev-live.json';
import sandboxAdapter from './datev-sandbox.json';

type DatevAdapter = {
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, any>;
    headers: Record<string, string>;
  };
  tools: Array<{
    name: string;
    endpointMapping: { method: string; path: string };
  }>;
};

const live = liveAdapter as unknown as DatevAdapter;
const sandbox = sandboxAdapter as unknown as DatevAdapter;

// POST tools only create read-export jobs on DATEV's side.
const EXPORT_JOB_TOOLS = [
  'datev_live_dataexchange_create_account_postings_job',
  'datev_live_dataexchange_create_open_items_job',
  'datev_live_dataexchange_create_sums_and_balances_quantity_and_weight_job',
];

describe('DATEV live adapter', () => {
  it('uses OAuth2 client_secret_basic token endpoint auth', () => {
    expect(live.connector.authType).toBe('OAUTH2');
    expect(live.connector.authConfig.tokenAuthMethod).toBe(
      'client_secret_basic',
    );
  });

  it('pins OAuth endpoints to DATEV production', () => {
    const auth = live.connector.authConfig;
    expect(auth.authorizationUrl).toBe(
      'https://login.datev.de/openid/authorize',
    );
    expect(auth.tokenUrl).toBe('https://api.datev.de/token');
    expect(auth.revocationUrl).toBe('https://api.datev.de/revoke');
    expect(auth.userinfoUrl).toBe('https://api.datev.de/userinfo');
    expect(JSON.stringify(live.connector)).not.toMatch(/sandbox/);
  });

  it('pins connector and tool URLs to production platform paths', () => {
    expect(live.connector.baseUrl).toBe(
      'https://accounting-clients.api.datev.de/platform/v2',
    );

    for (const tool of live.tools) {
      expect(tool.name).toMatch(/^datev_live_/);
      expect(tool.endpointMapping.path).toMatch(
        /^https:\/\/[a-z0-9-]+\.api\.datev\.de\/platform\/v[12]\//,
      );
    }
  });

  it('exposes only read or export-job tools', () => {
    for (const tool of live.tools) {
      if (EXPORT_JOB_TOOLS.includes(tool.name)) {
        expect(tool.endpointMapping.method).toBe('POST');
      } else {
        expect(tool.endpointMapping.method).toBe('GET');
      }
    }
  });

  it('excludes accounting-documents tools and scope', () => {
    const auth = live.connector.authConfig;
    expect(auth.scopes.split(' ')).not.toContain('accounting:documents');
    expect(
      auth.scopeSelection.options.map((o: { id: string }) => o.id),
    ).toEqual(['accounting-clients', 'accounting-dataexchange']);
    for (const tool of live.tools) {
      expect(tool.endpointMapping.path).not.toContain('accounting-documents');
    }
    expect(live.tools).toHaveLength(sandbox.tools.length - 4);
  });

  it('verifies authorization with the live client list tool', () => {
    expect(live.connector.authConfig.postAuthVerifyTool).toBe(
      'datev_live_list_clients',
    );
  });

  it('sends the mandatory DATEV client id header', () => {
    expect(live.connector.headers['X-DATEV-Client-Id']).toBe(
      '{{DATEV_CLIENT_ID}}',
    );
  });
});
