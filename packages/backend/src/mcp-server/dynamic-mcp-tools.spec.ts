import { readFile } from 'fs/promises';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';

describe('DynamicMcpTools Microsoft Graph mail attachments', () => {
  const baseTool = {
    id: 'tool-1',
    connectorId: 'connector-1',
    organizationId: 'org-1',
    name: 'microsoft_graph_mail_get_email_attachment',
    description: 'Get attachment',
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: {
      baseUrl: 'https://graph.microsoft.com/v1.0',
      authType: 'BEARER_TOKEN',
      authConfig: undefined,
      headers: {},
      envVars: {},
      config: {},
    },
    endpointMapping: {
      method: 'GET',
      path: '/me/messages/{messageId}/attachments/{attachmentId}',
    },
  };

  function makeSubject(result: unknown, toolOverride: Record<string, any> = {}) {
    const tool = {
      ...baseTool,
      ...toolOverride,
      connectorConfig: {
        ...baseTool.connectorConfig,
        ...toolOverride.connectorConfig,
      },
    };
    const registry = {
      getTool: jest.fn().mockReturnValue(tool),
      getToolForOrg: jest.fn().mockReturnValue(tool),
    };
    const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      incr: jest.fn(),
      expire: jest.fn(),
      ttl: jest.fn(),
    };
    const license = { checkLicenseActive: jest.fn().mockResolvedValue(undefined) };
    const deployment = { isCloud: jest.fn().mockReturnValue(false) };
    const prisma = { organization: { findUnique: jest.fn() } };
    const rest = { execute: jest.fn().mockResolvedValue(result) };
    const kg = { scheduleObservationalIngest: jest.fn() };
    const connectorAuth = { getUserCredential: jest.fn().mockResolvedValue(null) };

    const subject = new DynamicMcpTools(
      registry as any,
      audit as any,
      redis as any,
      license as any,
      deployment as any,
      prisma as any,
      rest as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      kg as any,
      connectorAuth as any,
    );

    return { subject, audit, rest };
  }

  it('decodes text attachments and never returns contentBytes/base64 as JSON text', async () => {
    const original = 'hello from attachment';
    const base64 = Buffer.from(original, 'utf8').toString('base64');
    const { subject, audit } = makeSubject({
      id: 'att-1',
      name: 'note.txt',
      contentType: 'text/plain',
      contentBytes: base64,
    });

    const result = await subject.executeTool(
      'microsoft_graph_mail_get_email_attachment',
      { messageId: 'm1', attachmentId: 'a1' },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as any).text).toContain(original);
    expect((result.content[0] as any).text).not.toContain('contentBytes');
    expect((result.content[0] as any).text).not.toContain(base64);
    expect(audit.logInvocation.mock.calls[0][0].output).not.toHaveProperty(
      'contentBytes',
    );
  });

  it('passes connectorId to the REST engine so OAuth token caches stay per connector', async () => {
    const { subject, rest } = makeSubject(
      { id: 'me', userPrincipalName: 'first@example.com' },
      {
        connectorId: 'graph-connector-a',
        name: 'microsoft_graph_mail_get_profile',
        endpointMapping: {
          method: 'GET',
          path: '/me',
        },
        connectorConfig: {
          ...baseTool.connectorConfig,
          authType: 'OAUTH2',
          authConfig: JSON.stringify({
            tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
            accessToken: 'token-a',
            refreshToken: 'refresh-a',
          }),
        },
      },
    );

    await subject.executeTool('microsoft_graph_mail_get_profile', {});

    expect(rest.execute).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'graph-connector-a' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('returns images as MCP image content blocks, not text-embedded bytes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const base64 = bytes.toString('base64');
    const { subject, audit } = makeSubject({
      id: 'att-2',
      name: 'image.png',
      contentType: 'image/png',
      contentBytes: base64,
    });

    const result = await subject.executeTool(
      'microsoft_graph_mail_get_email_attachment',
      { messageId: 'm1', attachmentId: 'a2' },
    );

    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as any).text).not.toContain(base64);
    expect(result.content[1]).toEqual({
      type: 'image',
      data: base64,
      mimeType: 'image/png',
    });
    expect(audit.logInvocation.mock.calls[0][0].output).toMatchObject({
      disposition: 'image_content_block',
      contentType: 'image/png',
    });
    expect(JSON.stringify(audit.logInvocation.mock.calls[0][0].output)).not.toContain(
      base64,
    );
  });

  it('saves unsupported binaries to disk and returns a reference', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const { subject } = makeSubject({
      id: 'att-3',
      name: 'archive.zip',
      contentType: 'application/zip',
      contentBytes: bytes.toString('base64'),
    });

    const result = await subject.executeTool(
      'microsoft_graph_mail_get_email_attachment',
      { messageId: 'm1', attachmentId: 'a3' },
    );

    const text = (result.content[0] as any).text as string;
    const payload = JSON.parse(text);
    expect(payload.note).toContain('saved to disk');
    expect(payload.filePath).toContain('archive.zip');
    await expect(readFile(payload.filePath)).resolves.toEqual(bytes);
    expect(text).not.toContain(bytes.toString('base64'));
  });

  it('handles invalid base64 with a clear text error', async () => {
    const { subject } = makeSubject({
      id: 'att-4',
      name: 'broken.pdf',
      contentType: 'application/pdf',
      contentBytes: 'not valid base64!',
    });

    const result = await subject.executeTool(
      'microsoft_graph_mail_get_email_attachment',
      { messageId: 'm1', attachmentId: 'a4' },
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as any).text).toContain('Failed to decode');
  });

  it('falls back to a file reference when PDF parsing fails', async () => {
    const bytes = Buffer.from('not actually a pdf', 'utf8');
    const { subject } = makeSubject({
      id: 'att-5',
      name: 'document.pdf',
      contentType: 'application/pdf',
      contentBytes: bytes.toString('base64'),
    });

    const result = await subject.executeTool(
      'microsoft_graph_mail_get_email_attachment',
      { messageId: 'm1', attachmentId: 'a5' },
    );

    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.note).toContain('PDF text extraction failed');
    expect(payload.filePath).toContain('document.pdf');
  });
});

/**
 * Runtime behaviour of response shaping, the response cache and the workflow
 * hint — the three things that share the result-rendering path.
 */

const RAW = {
  pageDetails: { count: 1, totalCount: 812 },
  devices: [
    { id: 1, hostname: 'PC-01', deviceType: { category: 'Desktop' }, udf: { u1: 'x' } },
  ],
};

const SELECT_TRANSFORM = {
  transform: {
    select: {
      total: '$.pageDetails.totalCount',
      devices: { $from: '$.devices[*]', $select: { hostname: 'hostname', category: 'deviceType.category' } },
    },
  },
};

const MAPPED = { total: 812, devices: [{ hostname: 'PC-01', category: 'Desktop' }] };

function makeTool(responseMapping?: Record<string, unknown>): RegisteredTool {
  return {
    id: 'tool-1',
    connectorId: 'conn-1',
    organizationId: 'org-1',
    name: 'list_devices',
    description: 'List devices',
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://api.example.com', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/devices' },
    responseMapping,
  };
}

function build(tool: RegisteredTool, opts: { engineResult?: unknown; cached?: string | null } = {}) {
  const redis = {
    get: jest.fn().mockResolvedValue(opts.cached ?? null),
    set: jest.fn().mockResolvedValue(undefined),
    incr: jest.fn(),
    expire: jest.fn(),
    ttl: jest.fn(),
  };
  const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
  const restEngine = {
    execute: jest.fn().mockResolvedValue(opts.engineResult ?? RAW),
  };
  const executor = new DynamicMcpTools(
    { getTool: () => tool, getToolForOrg: () => tool } as any,
    audit as any,
    redis as any,
    { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
    { isCloud: () => false } as any,
    {} as any,
    restEngine as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { scheduleObservationalIngest: jest.fn() } as any,
    { getUserCredential: jest.fn().mockResolvedValue(null) } as any,
  );
  return { executor, redis, audit, restEngine };
}

describe('DynamicMcpTools — response shaping', () => {
  it('leaves the output byte-identical when no transform is configured', async () => {
    const { executor } = build(makeTool());
    const res = await executor.executeTool('list_devices', {});
    expect(res.content[0].text).toBe(JSON.stringify(RAW, null, 2));
    expect(res.isError).toBeUndefined();
  });

  it('is a no-op when responseMapping only carries cacheTtl / followUp', async () => {
    const { executor } = build(makeTool({ cacheTtl: 0, followUp: undefined }));
    const res = await executor.executeTool('list_devices', {});
    expect(res.content[0].text).toBe(JSON.stringify(RAW, null, 2));
  });

  it('applies a configured transform to the text and to structuredContent', async () => {
    const { executor } = build(makeTool(SELECT_TRANSFORM));
    const res = await executor.executeTool('list_devices', {});
    expect(JSON.parse(res.content[0].text)).toEqual(MAPPED);
    expect(res.structured).toEqual(MAPPED);
  });

  it('applies the transform for every connector type, not just REST', async () => {
    const soapTool = { ...makeTool(SELECT_TRANSFORM), connectorType: 'SOAP' };
    const soapEngine = { execute: jest.fn().mockResolvedValue(RAW) };
    const executor = new DynamicMcpTools(
      { getTool: () => soapTool, getToolForOrg: () => soapTool } as any,
      { logInvocation: jest.fn() } as any,
      { get: jest.fn(), set: jest.fn() } as any,
      { checkLicenseActive: jest.fn() } as any,
      { isCloud: () => false } as any,
      {} as any,
      {} as any,
      {} as any,
      soapEngine as any,
      {} as any,
      {} as any,
      { scheduleObservationalIngest: jest.fn() } as any,
      { getUserCredential: jest.fn().mockResolvedValue(null) } as any,
    );
    const res = await executor.executeTool('list_devices', {});
    expect(soapEngine.execute).toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toEqual(MAPPED);
  });

  it('appends the workflow hint after the mapped payload, and keeps structuredContent parseable', async () => {
    const { executor } = build(makeTool({ ...SELECT_TRANSFORM, followUp: 'now call get_device' }));
    const res = await executor.executeTool('list_devices', {});
    expect(res.content[0].text).toContain('WORKFLOW HINT');
    expect(res.content[0].text.startsWith(JSON.stringify(MAPPED, null, 2))).toBe(true);
    // The whole text is no longer valid JSON — this is exactly why the
    // executor hands back `structured` instead of making callers re-parse it.
    expect(() => JSON.parse(res.content[0].text)).toThrow();
    expect(res.structured).toEqual(MAPPED);
  });

  it('audits the RAW response, not the mapped one', async () => {
    const { executor, audit } = build(makeTool(SELECT_TRANSFORM));
    await executor.executeTool('list_devices', {});
    expect(audit.logInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ output: RAW, status: 'SUCCESS' }),
    );
  });

  it('returns the raw response and does not fail the call when the mapping is broken', async () => {
    const { executor } = build(makeTool({ transform: { select: { bad: 'a[' } } }));
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual(RAW);
  });

  it('surfaces the error instead when fallbackToRaw is false', async () => {
    const { executor } = build(
      makeTool({ transform: { fallbackToRaw: false, select: { bad: 'a[' } } }),
    );
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/Response mapping failed/);
  });
});

describe('DynamicMcpTools — response cache', () => {
  it('caches the raw response, not the rendered text', async () => {
    const { executor, redis } = build(makeTool({ ...SELECT_TRANSFORM, cacheTtl: 300 }));
    await executor.executeTool('list_devices', {});
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = redis.set.mock.calls[0];
    expect(key).toMatch(/^tool_cache:v2:conn-1:list_devices:/);
    expect(ttl).toBe(300);
    expect(JSON.parse(value)).toEqual(RAW);
  });

  it('re-applies the mapping on a cache hit, so a mapping edit takes effect at once', async () => {
    const { executor, restEngine } = build(makeTool({ ...SELECT_TRANSFORM, cacheTtl: 300 }), {
      cached: JSON.stringify(RAW),
    });
    const res = await executor.executeTool('list_devices', {});
    expect(restEngine.execute).not.toHaveBeenCalled(); // served from cache
    expect(JSON.parse(res.content[0].text)).toEqual(MAPPED);
    expect(res.structured).toEqual(MAPPED);
  });

  it('re-executes rather than serving an unparsable cache entry', async () => {
    const { executor, restEngine } = build(makeTool({ cacheTtl: 300 }), {
      cached: 'not json{',
    });
    const res = await executor.executeTool('list_devices', {});
    expect(restEngine.execute).toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toEqual(RAW);
  });

  it('does not touch the cache when cacheTtl is absent', async () => {
    const { executor, redis } = build(makeTool(SELECT_TRANSFORM));
    await executor.executeTool('list_devices', {});
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
