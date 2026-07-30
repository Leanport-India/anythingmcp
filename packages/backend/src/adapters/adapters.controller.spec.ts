import { ForbiddenException } from '@nestjs/common';
import { AdaptersController } from './adapters.controller';

function buildController() {
  const adaptersService = {
    importAdapter: jest
      .fn()
      .mockResolvedValue({ connectorId: 'c1', toolsCreated: 3 }),
  };
  const licenseGuard = {
    checkCanCreateConnector: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new AdaptersController(
    adaptersService as any,
    licenseGuard as any,
  );
  return { controller, adaptersService, licenseGuard };
}

const req = (role: string) => ({
  user: { sub: 'u1', organizationId: 'org1', role },
});

describe('AdaptersController role enforcement', () => {
  describe('POST /api/adapters/:slug/import (importAdapter)', () => {
    it.each(['EDITOR', 'VIEWER'])('rejects %s before importing the adapter', async (role) => {
      const { controller, adaptersService, licenseGuard } = buildController();

      await expect(
        controller.importAdapter(req(role), 'some-slug', {}),
      ).rejects.toThrow(ForbiddenException);

      expect(licenseGuard.checkCanCreateConnector).not.toHaveBeenCalled();
      expect(adaptersService.importAdapter).not.toHaveBeenCalled();
    });

    it('allows ADMIN to import an adapter', async () => {
      const { controller, adaptersService } = buildController();

      await controller.importAdapter(req('ADMIN'), 'some-slug', {});

      expect(adaptersService.importAdapter).toHaveBeenCalledTimes(1);
    });
  });
});
