import { summarizeVerifyResponse } from './oauth2-lifecycle.util';

describe('summarizeVerifyResponse', () => {
  it('lists client ids and service names without client names', () => {
    const data = [
      {
        id: '29098-55003',
        name: 'Muster GmbH',
        services: [{ name: 'Datenservice Export Rechnungswesen', scopes: [] }],
      },
      { id: '29098-55004', name: 'Other GmbH', services: ['Rechnungswesen'] },
      { id: '29098-55005', name: 'No Services GmbH' },
    ];

    const summary = summarizeVerifyResponse(data, data);

    expect(summary.responseShape).toBe('array');
    expect(summary.clientCount).toBe(3);
    expect(summary.servicesSeen).toEqual([
      'Datenservice Export Rechnungswesen',
      'Rechnungswesen',
    ]);
    expect(summary.clients[2]).toEqual({
      id: '29098-55005',
      services: '(no services field)',
    });
    expect(JSON.stringify(summary)).not.toContain('GmbH');
  });

  it('reports the shape when no client list could be found', () => {
    const summary = summarizeVerifyResponse({ foo: 1, bar: 2 }, undefined);

    expect(summary.responseShape).toBe('object{foo,bar}');
    expect(summary.clientCount).toBeNull();
    expect(summary.clients).toEqual([]);
  });

  it('caps the logged clients at 25', () => {
    const data = Array.from({ length: 40 }, (_, i) => ({ id: String(i) }));

    const summary = summarizeVerifyResponse(data, data);

    expect(summary.clientCount).toBe(40);
    expect(summary.clients).toHaveLength(25);
  });
});
