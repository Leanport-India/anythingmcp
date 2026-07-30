export interface UserLike {
  role?: string | null;
}

export interface Capabilities {
  canViewDashboard: boolean;
  canManageConnectors: boolean;
  canManageMcpServers: boolean;
  canViewAudit: boolean;
  canViewAnalytics: boolean;
  canManageKnowledgeGraph: boolean;
  canViewOnboarding: boolean;
  canViewAdminSettings: boolean;
  canAuthorizeAssignedConnectors: boolean;
}

export function isAdmin(user?: UserLike | null): boolean {
  return user?.role === 'ADMIN';
}

export function getCapabilities(user?: UserLike | null): Capabilities {
  const admin = isAdmin(user);

  return {
    canViewDashboard: admin,
    canManageConnectors: admin,
    canManageMcpServers: admin,
    canViewAudit: admin,
    canViewAnalytics: admin,
    canManageKnowledgeGraph: admin,
    canViewOnboarding: admin,
    canViewAdminSettings: admin,
    // Placeholder for the next slice: a dedicated, sanitized "My Connections"
    // flow for non-admins to authorize admin-assigned connectors per account.
    canAuthorizeAssignedConnectors: !admin,
  };
}

