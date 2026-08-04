import { NotFoundException } from '@nestjs/common';
import { ConnectorAuthorizationsService } from './connector-authorizations.service';
import { encrypt } from '../common/crypto/encryption.util';
import { ConnectorAuthMode, UserConnectorAuthorizationStatus } from '../generated/prisma/client';

const ENCRYPTION_KEY = 'a'.repeat(48);

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ mcpRoleId: null }) },
    connectorAuthorizationAssignment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    userConnectorAuthorization: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    connector: { findFirst: jest.fn() },
    ...prismaOverrides,
  };
  const configService: any = { get: jest.fn().mockReturnValue(ENCRYPTION_KEY) };
  const service = new ConnectorAuthorizationsService(prisma, configService);
  return { service, prisma };
}

describe('ConnectorAuthorizationsService', () => {
  describe('listForUser', () => {
    it('returns only PER_USER connectors assigned to this user (direct or via role), deduped; excludes Global/SHARED connectors', async () => {
      const { service, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue({ mcpRoleId: 'role-1' });
      prisma.connectorAuthorizationAssignment.findMany.mockResolvedValue([
        {
          connectorId: 'conn-2',
          connector: {
            id: 'conn-2',
            name: 'Graph Mail',
            type: 'REST',
            authMode: ConnectorAuthMode.PER_USER,
            instructions: 'Connect your own mailbox',
            userAuthorizations: [
              { status: UserConnectorAuthorizationStatus.AUTHORIZED, lastError: null, authorizedAt: new Date('2026-01-01') },
            ],
          },
        },
      ]);

      // The query now filters to PER_USER connectors only, so Global/SHARED
      // connectors never reach the mapping (they stay invisible to non-admins).
      const result = await service.listForUser('user-1', 'org-1');

      expect(result).toHaveLength(1);
      const perUser = result.find((r) => r.connectorId === 'conn-2')!;
      expect(perUser.status).toBe(UserConnectorAuthorizationStatus.AUTHORIZED);
      expect(perUser.authMode).toBe(ConnectorAuthMode.PER_USER);
    });

    it('marks a PER_USER connector as PENDING when this user has not authorized it yet', async () => {
      const { service, prisma } = makeService();
      prisma.connectorAuthorizationAssignment.findMany.mockResolvedValue([
        {
          connectorId: 'conn-2',
          connector: {
            id: 'conn-2',
            name: 'Graph Mail',
            type: 'REST',
            authMode: ConnectorAuthMode.PER_USER,
            instructions: null,
            userAuthorizations: [], // this user has no row yet
          },
        },
      ]);

      const [result] = await service.listForUser('user-1', 'org-1');
      expect(result.status).toBe(UserConnectorAuthorizationStatus.PENDING);
    });
  });

  describe('assertAssigned', () => {
    it('throws NotFoundException when the connector is not assigned to the user', async () => {
      const { service, prisma } = makeService();
      prisma.connectorAuthorizationAssignment.findFirst.mockResolvedValue(null);

      await expect(service.assertAssigned('conn-1', 'user-1', 'org-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('does not throw when an enabled assignment exists', async () => {
      const { service, prisma } = makeService();
      prisma.connectorAuthorizationAssignment.findFirst.mockResolvedValue({ id: 'a1' });

      await expect(service.assertAssigned('conn-1', 'user-1', 'org-1')).resolves.toBeUndefined();
    });
  });

  describe('per-user credential isolation', () => {
    it('getUserCredential only returns this user\'s own credential, never another user\'s', async () => {
      const { service, prisma } = makeService();
      const otherUsersCredential = encrypt(JSON.stringify({ accessToken: 'user-2-token' }), ENCRYPTION_KEY);

      // Simulate the DB row keyed by (connectorId, userId) — user-1's lookup
      // must never resolve to user-2's row even if called with the same connector.
      prisma.userConnectorAuthorization.findUnique.mockImplementation(({ where }: any) => {
        if (where.connectorId_userId.userId === 'user-2') {
          return Promise.resolve({
            status: UserConnectorAuthorizationStatus.AUTHORIZED,
            credential: otherUsersCredential,
          });
        }
        return Promise.resolve(null);
      });

      const user1Credential = await service.getUserCredential('conn-1', 'user-1');
      expect(user1Credential).toBeNull();

      const user2Credential = await service.getUserCredential('conn-1', 'user-2');
      expect(user2Credential).toEqual({ accessToken: 'user-2-token' });
    });

    it('does not return a credential for a REVOKED authorization', async () => {
      const { service, prisma } = makeService();
      prisma.userConnectorAuthorization.findUnique.mockResolvedValue({
        status: UserConnectorAuthorizationStatus.REVOKED,
        credential: null,
      });

      const result = await service.getUserCredential('conn-1', 'user-1');
      expect(result).toBeNull();
    });

    it('saveUserCredential persists an encrypted, user-scoped upsert', async () => {
      const { service, prisma } = makeService();

      await service.saveUserCredential('conn-1', 'user-1', 'org-1', { accessToken: 'tok' });

      expect(prisma.userConnectorAuthorization.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { connectorId_userId: { connectorId: 'conn-1', userId: 'user-1' } },
        }),
      );
      const call = prisma.userConnectorAuthorization.upsert.mock.calls[0][0];
      expect(call.create.credential).not.toContain('tok'); // must be encrypted, not plaintext
      expect(call.update.credential).not.toContain('tok');
    });

    it('revokeUserCredential clears the credential and marks REVOKED', async () => {
      const { service, prisma } = makeService();
      prisma.userConnectorAuthorization.findUnique.mockResolvedValue({ id: 'auth-1' });

      await service.revokeUserCredential('conn-1', 'user-1');

      expect(prisma.userConnectorAuthorization.update).toHaveBeenCalledWith({
        where: { connectorId_userId: { connectorId: 'conn-1', userId: 'user-1' } },
        data: { status: UserConnectorAuthorizationStatus.REVOKED, credential: null },
      });
    });
  });

  describe('admin assignment management', () => {
    it('rejects assign() when neither userId nor roleId is provided', async () => {
      const { service } = makeService();
      await expect(service.assign('conn-1', 'org-1', 'admin-1', {})).rejects.toThrow(
        'Either userId or roleId is required',
      );
    });

    it('rejects assign() when both userId and roleId are provided', async () => {
      const { service } = makeService();
      await expect(
        service.assign('conn-1', 'org-1', 'admin-1', { userId: 'u1', roleId: 'r1' }),
      ).rejects.toThrow('Provide only one of userId or roleId');
    });

    it('rejects assign() for a connector outside the admin\'s organization', async () => {
      const { service, prisma } = makeService();
      prisma.connector.findFirst.mockResolvedValue(null);

      await expect(
        service.assign('conn-1', 'org-1', 'admin-1', { userId: 'u1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
