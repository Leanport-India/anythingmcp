import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { encrypt, decrypt } from '../common/crypto/encryption.util';
import { getRequiredSecret } from '../common/secrets.util';
import { ConnectorAuthMode, UserConnectorAuthorizationStatus } from '../generated/prisma/client';
import { revokeOAuth2Token } from './engines/oauth2-lifecycle.util';

export interface AssignedConnectorSummary {
  connectorId: string;
  name: string;
  type: string;
  authMode: ConnectorAuthMode;
  icon: string | null;
  instructions: string | null;
  // For SHARED connectors this is always AUTHORIZED once the admin has set one
  // up — there is nothing for the end user to do. For PER_USER connectors it
  // reflects this user's own authorization record (or PENDING if none exists).
  status: UserConnectorAuthorizationStatus;
  lastError: string | null;
  authorizedAt: Date | null;
  // DATEV interface-requirements fields (generic — populated only for
  // adapters that declare userinfoUrl / refreshTokenLifetimeDays /
  // postAuthVerifyTool / connectedAppsUrl; undefined for every other adapter).
  issuedToName?: string;
  refreshTokenExpiresAt?: number;
  verifiedDatasetLabel?: string;
  connectedAppsUrl?: string;
}

/**
 * End-user facing connector authorization surface ("My Connections").
 *
 * A non-admin user may only see connectors that an admin has explicitly
 * assigned to them (directly, or via their MCP role) through
 * ConnectorAuthorizationAssignment. This is intentionally separate from:
 *  - ToolRoleAccess (which tools a user may invoke once authorized)
 *  - admin connector-management capability (who may edit connector definitions)
 */
@Injectable()
export class ConnectorAuthorizationsService {
  private readonly logger = new Logger(ConnectorAuthorizationsService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      this.configService.get<string>('ENCRYPTION_KEY'),
    );
  }

  /**
   * List connectors this user must (or may) self-authorize — i.e. PER_USER
   * connectors assigned to them directly or via their MCP role — with
   * sanitized fields only (no base URL, headers, auth config).
   *
   * Global (SHARED) connectors are intentionally NOT listed here: everyone in
   * the organization can already call their tools through the admin-managed
   * shared credential, so there is nothing for a non-admin to act on.
   */
  async listForUser(
    userId: string,
    organizationId: string,
  ): Promise<AssignedConnectorSummary[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mcpRoleId: true },
    });

    const assignments = await this.prisma.connectorAuthorizationAssignment.findMany({
      where: {
        organizationId,
        enabled: true,
        connector: { authMode: ConnectorAuthMode.PER_USER },
        OR: [
          { userId },
          ...(user?.mcpRoleId ? [{ roleId: user.mcpRoleId }] : []),
        ],
      },
      include: {
        connector: {
          include: {
            userAuthorizations: { where: { userId } },
          },
        },
      },
    });

    // A connector may be assigned both directly and via role — dedupe by connectorId.
    const byConnectorId = new Map<string, (typeof assignments)[number]>();
    for (const a of assignments) {
      if (!byConnectorId.has(a.connectorId)) byConnectorId.set(a.connectorId, a);
    }

    return [...byConnectorId.values()].map((a) => {
      const connector = a.connector;
      const userAuth = connector.userAuthorizations[0];

      let credential: Record<string, unknown> | null = null;
      if (userAuth?.credential) {
        try {
          credential = JSON.parse(decrypt(userAuth.credential, this.encryptionKey));
        } catch {
          // Rotated key or corrupt entry — omit the enrichment fields rather
          // than failing the whole list.
        }
      }
      let staticAuthConfig: Record<string, unknown> | null = null;
      if (connector.authConfig) {
        try {
          staticAuthConfig = JSON.parse(decrypt(connector.authConfig, this.encryptionKey));
        } catch {
          // Same as above.
        }
      }

      const issuedToName = credential?.issuedToName;
      const refreshTokenExpiresAt = credential?.refreshTokenExpiresAt;
      const verifiedDatasetLabel = credential?.verifiedDatasetLabel;
      const connectedAppsUrl = staticAuthConfig?.connectedAppsUrl;

      return {
        connectorId: connector.id,
        name: connector.name,
        type: connector.type,
        authMode: connector.authMode,
        icon: null,
        instructions: connector.instructions,
        status: userAuth?.status ?? UserConnectorAuthorizationStatus.PENDING,
        lastError: userAuth?.lastError ?? null,
        authorizedAt: userAuth?.authorizedAt ?? null,
        issuedToName: typeof issuedToName === 'string' ? issuedToName : undefined,
        refreshTokenExpiresAt:
          typeof refreshTokenExpiresAt === 'number' ? refreshTokenExpiresAt : undefined,
        verifiedDatasetLabel:
          typeof verifiedDatasetLabel === 'string' ? verifiedDatasetLabel : undefined,
        connectedAppsUrl: typeof connectedAppsUrl === 'string' ? connectedAppsUrl : undefined,
      };
    });
  }

  /**
   * Verify that `connectorId` is assigned to `userId` (directly or via role).
   * Throws NotFoundException if not — callers must never distinguish
   * "exists but not assigned" from "does not exist" in their response.
   */
  async assertAssigned(
    connectorId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mcpRoleId: true },
    });

    const assignment = await this.prisma.connectorAuthorizationAssignment.findFirst({
      where: {
        connectorId,
        organizationId,
        enabled: true,
        OR: [
          { userId },
          ...(user?.mcpRoleId ? [{ roleId: user.mcpRoleId }] : []),
        ],
      },
    });

    if (!assignment) {
      throw new NotFoundException('Connector not found');
    }
  }

  /**
   * Load this user's decrypted credential for a PER_USER connector, or null
   * if they have not authorized it (or it is not a PER_USER connector).
   */
  async getUserCredential(
    connectorId: string,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const record = await this.prisma.userConnectorAuthorization.findUnique({
      where: { connectorId_userId: { connectorId, userId } },
    });
    if (!record?.credential) return null;
    if (record.status !== UserConnectorAuthorizationStatus.AUTHORIZED) return null;
    return JSON.parse(decrypt(record.credential, this.encryptionKey));
  }

  /**
   * Persist this user's OAuth2 credential for a PER_USER connector.
   */
  async saveUserCredential(
    connectorId: string,
    userId: string,
    organizationId: string,
    credential: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.userConnectorAuthorization.upsert({
      where: { connectorId_userId: { connectorId, userId } },
      create: {
        connectorId,
        userId,
        organizationId,
        status: UserConnectorAuthorizationStatus.AUTHORIZED,
        credential: encrypt(JSON.stringify(credential), this.encryptionKey),
        lastError: null,
        authorizedAt: new Date(),
      },
      update: {
        status: UserConnectorAuthorizationStatus.AUTHORIZED,
        credential: encrypt(JSON.stringify(credential), this.encryptionKey),
        lastError: null,
        authorizedAt: new Date(),
      },
    });
  }

  async recordUserAuthError(
    connectorId: string,
    userId: string,
    organizationId: string,
    message: string,
  ): Promise<void> {
    await this.prisma.userConnectorAuthorization.upsert({
      where: { connectorId_userId: { connectorId, userId } },
      create: {
        connectorId,
        userId,
        organizationId,
        status: UserConnectorAuthorizationStatus.ERROR,
        lastError: message,
      },
      update: {
        status: UserConnectorAuthorizationStatus.ERROR,
        lastError: message,
      },
    });
  }

  async revokeUserCredential(connectorId: string, userId: string): Promise<void> {
    const record = await this.prisma.userConnectorAuthorization.findUnique({
      where: { connectorId_userId: { connectorId, userId } },
    });
    if (!record) return;

    // Best-effort OAuth2 revocation (RFC 7009) before clearing the local
    // credential — DATEV's interface requirements mandate the RT actually be
    // revoked at the provider, not just deleted from our own storage.
    if (record.credential) {
      try {
        const credential = JSON.parse(
          decrypt(record.credential, this.encryptionKey),
        ) as Record<string, unknown>;
        const connector = await this.prisma.connector.findUnique({
          where: { id: connectorId },
          select: { authConfig: true },
        });
        const staticAuthConfig = connector?.authConfig
          ? (JSON.parse(decrypt(connector.authConfig, this.encryptionKey)) as Record<string, unknown>)
          : {};
        await revokeOAuth2Token({ ...staticAuthConfig, ...credential }, this.logger);
      } catch (err: any) {
        this.logger.warn(
          `Failed to revoke token before disconnect (connector ${connectorId}, user ${userId}): ${err.message}`,
        );
      }
    }

    await this.prisma.userConnectorAuthorization.update({
      where: { connectorId_userId: { connectorId, userId } },
      data: {
        status: UserConnectorAuthorizationStatus.REVOKED,
        credential: null,
      },
    });
  }

  // ── Admin: manage assignments ─────────────────────────────────────────────

  async listAssignmentsForConnector(connectorId: string, organizationId: string) {
    return this.prisma.connectorAuthorizationAssignment.findMany({
      where: { connectorId, organizationId },
      include: {
        user: { select: { id: true, email: true, name: true } },
        role: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async assign(
    connectorId: string,
    organizationId: string,
    createdBy: string,
    target: { userId?: string; roleId?: string },
  ) {
    if (!target.userId && !target.roleId) {
      throw new BadRequestException('Either userId or roleId is required');
    }
    if (target.userId && target.roleId) {
      throw new BadRequestException('Provide only one of userId or roleId');
    }

    const connector = await this.prisma.connector.findFirst({
      where: { id: connectorId, organizationId },
      select: { id: true },
    });
    if (!connector) {
      throw new NotFoundException(`Connector ${connectorId} not found`);
    }

    return this.prisma.connectorAuthorizationAssignment.upsert({
      where: target.userId
        ? { connectorId_userId: { connectorId, userId: target.userId } }
        : { connectorId_roleId: { connectorId, roleId: target.roleId! } },
      create: {
        connectorId,
        organizationId,
        createdBy,
        userId: target.userId,
        roleId: target.roleId,
        enabled: true,
      },
      update: { enabled: true },
    });
  }

  async unassign(assignmentId: string, organizationId: string): Promise<void> {
    const assignment = await this.prisma.connectorAuthorizationAssignment.findFirst({
      where: { id: assignmentId, organizationId },
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${assignmentId} not found`);
    }
    await this.prisma.connectorAuthorizationAssignment.delete({
      where: { id: assignmentId },
    });
  }
}
