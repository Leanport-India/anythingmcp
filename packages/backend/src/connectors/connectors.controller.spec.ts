import { ForbiddenException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';

const VALID_ENCRYPTION_KEY = 'a'.repeat(48);

function buildController(overrides: {
  connectorsService?: any;
  prisma?: any;
  mcpServer?: any;
  licenseGuard?: any;
} = {}) {
  const connectorsService = overrides.connectorsService ?? {
    create: jest.fn().mockResolvedValue({ id: 'c1', type: 'REST' }),
  };
  const prisma = overrides.prisma ?? {
    connector: { create: jest.fn().mockResolvedValue({ id: 'c1' }) },
    mcpTool: { create: jest.fn() },
  };
  const mcpServer = overrides.mcpServer ?? {
    reloadConnectorTools: jest.fn().mockResolvedValue(undefined),
  };
  const licenseGuard = overrides.licenseGuard ?? {
    checkCanCreateConnector: jest.fn().mockResolvedValue(undefined),
  };
  const configService = { get: jest.fn().mockReturnValue(VALID_ENCRYPTION_KEY) };

  const controller = new ConnectorsController(
    connectorsService as any,
    {} as any, // openApiParser
    {} as any, // wsdlParser
    {} as any, // graphqlParser
    {} as any, // postmanParser
    {} as any, // curlParser
    {} as any, // mcpClientEngine
    {} as any, // mcpOAuthService
    {} as any, // catalogResync
    prisma as any,
    mcpServer as any,
    configService as any,
    licenseGuard as any,
  );

  return { controller, connectorsService, prisma, mcpServer, licenseGuard };
}

const req = (role: string) => ({
  user: { sub: 'u1', organizationId: 'org1', role },
});

describe('ConnectorsController role enforcement', () => {
  describe('POST /api/connectors (create)', () => {
    it.each(['EDITOR', 'VIEWER'])('rejects %s before creating the connector', async (role) => {
      const { controller, connectorsService, licenseGuard } = buildController();

      await expect(
        controller.create(req(role), {
          name: 'viewer-created-test',
          type: 'REST' as any,
          baseUrl: 'https://example.invalid',
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(licenseGuard.checkCanCreateConnector).not.toHaveBeenCalled();
      expect(connectorsService.create).not.toHaveBeenCalled();
    });

    it('allows ADMIN to create a connector', async () => {
      const { controller, connectorsService } = buildController();

      await controller.create(req('ADMIN'), {
        name: 'ok',
        type: 'REST' as any,
        baseUrl: 'https://example.invalid',
      });

      expect(connectorsService.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/connectors/import-all (importAll)', () => {
    it.each(['EDITOR', 'VIEWER'])('rejects %s before importing any connector', async (role) => {
      const { controller, prisma } = buildController();

      await expect(
        controller.importAll(req(role), {
          connectors: [
            {
              name: 'viewer-imported-test',
              type: 'REST' as any,
              baseUrl: 'https://example.invalid',
            },
          ],
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.connector.create).not.toHaveBeenCalled();
    });

    it('allows ADMIN to import connectors', async () => {
      const { controller, prisma } = buildController();

      await controller.importAll(req('ADMIN'), {
        connectors: [
          {
            name: 'imported',
            type: 'REST' as any,
            baseUrl: 'https://example.invalid',
          },
        ],
      });

      expect(prisma.connector.create).toHaveBeenCalledTimes(1);
    });
  });
});
