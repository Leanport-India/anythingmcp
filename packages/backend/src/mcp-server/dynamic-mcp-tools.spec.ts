import { readFile } from 'fs/promises';
import { DynamicMcpTools } from './dynamic-mcp-tools';

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
