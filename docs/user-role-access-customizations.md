# User Role and Access Customizations

Date: 2026-07-31

This document records the local role/access-control customizations in this
fork, especially the fixes that stop non-admin users from seeing connector,
MCP server, audit, analytics, and related admin surfaces.

## Summary

This fork tightened the web app and API from an owner/editor/viewer-oriented
model to an admin-only management model for sensitive workspace configuration.

Current behavior:

- `ADMIN` can view and manage connectors, adapter imports, connector tools,
  MCP servers, MCP API keys, audit logs, analytics, knowledge graph/admin
  settings, and onboarding.
- `EDITOR` and `VIEWER` are blocked from those management surfaces.
- Non-admin users can still access personal profile settings.
- A future "My Connections" flow is still planned for non-admin users who
  should authorize only admin-assigned connectors. That flow is not implemented
  yet.

The intent is defense in depth:

- frontend navigation hides restricted areas;
- direct route visits render an access-denied state;
- backend APIs reject unauthorized requests with `403`;
- tests were adjusted so `EDITOR` and `VIEWER` are rejected where management
  APIs used to allow broader access.

## Backend Changes

### Shared admin capability helper

Added `packages/backend/src/auth/capabilities.ts`.

It defines:

- `isAdmin(user)`
- `assertAdmin(user, message)`

Controllers use this instead of repeating role checks. The helper currently
treats only `role === 'ADMIN'` as privileged.

### Adapter catalog import is admin-only

Changed `packages/backend/src/adapters/adapters.controller.ts`.

Effects:

- `GET /api/adapters/:slug` now requires admin access.
- `POST /api/adapters/:slug/import` now requires admin access.
- Previously, `VIEWER` was blocked from import, but `EDITOR` could import
  adapters. Now both `EDITOR` and `VIEWER` are rejected.

Tests updated in:

- `packages/backend/src/adapters/adapters.controller.spec.ts`

### Connector management is admin-only

Changed `packages/backend/src/connectors/connectors.controller.ts`.

Effects:

- `GET /api/connectors` now requires admin access.
- Connector create/update/delete/import/export/health-check paths require admin
  access.
- Proxy availability, which reveals connector runtime configuration, requires
  admin access.
- Previous owner/editor behavior was removed. Connector ownership no longer
  allows a non-admin to manage that connector.

Tests updated in:

- `packages/backend/src/connectors/connectors.controller.spec.ts`

### Connector tool management is admin-only

Changed `packages/backend/src/connectors/tools.controller.ts`.

Effects:

- `GET /api/connectors/:connectorId/tools` now requires admin access.
- Tool create/update/delete/test-style management paths require admin access.
- Previous owner/editor behavior was removed.

### MCP server management is admin-only

Changed `packages/backend/src/mcp-servers/mcp-servers.controller.ts`.

Effects:

- `GET /api/mcp-servers` requires admin access.
- `POST /api/mcp-servers` requires admin access.
- `GET /api/mcp-servers/:id` requires admin access after org validation.
- Server update/delete/assignment management requires admin access.

This fixes the earlier issue where non-admin users could still see MCP server
names, endpoints, assigned connector counts, and create server records.

### MCP API keys are admin-only

Changed `packages/backend/src/roles/mcp-api-keys.controller.ts`.

Effects:

- Listing MCP API keys requires admin access.
- Generating, revoking, and deleting MCP API keys requires admin access.

### Audit and analytics are admin-only

Changed `packages/backend/src/audit/audit.controller.ts`.

Effects:

- `GET /api/audit/invocations` requires admin access.
- `GET /api/audit/stats` requires admin access.
- `GET /api/audit/analytics` requires admin access.
- `GET /api/audit/breakdowns` requires admin access.

This prevents non-admin users from learning organization activity, connector
usage, error rates, and related operational details through direct API calls.

## Frontend Changes

### Shared frontend capability model

Added `packages/frontend/src/lib/capabilities.ts`.

The frontend now computes page/navigation capabilities from the current user.
At the moment, all admin/workspace management capabilities map to `ADMIN`.

Capabilities include:

- `canViewDashboard`
- `canManageConnectors`
- `canManageMcpServers`
- `canViewAudit`
- `canViewAnalytics`
- `canManageKnowledgeGraph`
- `canViewOnboarding`
- `canViewAdminSettings`
- `canAuthorizeAssignedConnectors`

`canAuthorizeAssignedConnectors` is a placeholder for a future non-admin "My
Connections" flow. It does not expose a working authorization surface yet.

### Shared access-denied screen

Added `packages/frontend/src/components/access-denied.tsx`.

Restricted direct route visits now render a consistent "Access restricted"
message instead of showing admin UI or firing admin API calls.

### Sidebar navigation is capability-filtered

Changed `packages/frontend/src/components/app-sidebar.tsx`.

Effects:

- Non-admin users no longer see navigation for:
  - Dashboard
  - Analytics
  - Audit Log
  - Connectors
  - Marketplace
  - MCP Servers
  - Knowledge Graph
  - AI Skills
  - Setup/onboarding
- Empty nav groups are removed.
- Active-link calculation only considers visible nav items.

### Connector pages are guarded

Changed:

- `packages/frontend/src/app/connectors/page.tsx`
- `packages/frontend/src/app/connectors/[id]/page.tsx`
- `packages/frontend/src/app/connectors/new/page.tsx`
- `packages/frontend/src/app/connectors/store/page.tsx`

Effects:

- Non-admin users see `AccessDenied`.
- Connector list/details/new/marketplace pages do not fetch connector or
  adapter data for non-admin users.
- Auto-install from `?install=<slug>` is skipped unless the user can manage
  connectors.

### MCP server pages are guarded

Changed:

- `packages/frontend/src/app/mcp-server/page.tsx`
- `packages/frontend/src/app/mcp-server/[id]/page.tsx`

Effects:

- Non-admin users see `AccessDenied`.
- Server lists, server details, and connector assignments are not fetched for
  non-admin users.

### Analytics, audit, knowledge graph, and onboarding are guarded

Changed:

- `packages/frontend/src/app/analytics/page.tsx`
- `packages/frontend/src/app/logs/page.tsx`
- `packages/frontend/src/app/knowledge-graph/page.tsx`
- `packages/frontend/src/app/knowledge-graph/skills/page.tsx`
- `packages/frontend/src/app/welcome/page.tsx`

Effects:

- Non-admin users see `AccessDenied`.
- Pages avoid fetching restricted API data when the user lacks the matching
  capability.

### Dashboard is admin-only for now

Changed `packages/frontend/src/app/page.tsx`.

The dashboard still contains organization-level connector counts, health
checks, analytics, and recent connector data, so it is admin-only for now.
Non-admin users receive a message that assigned connector authorization should
eventually appear in a dedicated "My Connections" area.

### Settings are split between personal and admin sections

Changed:

- `packages/frontend/src/app/settings/page.tsx`
- `packages/frontend/src/app/settings/layout.tsx`
- `packages/frontend/src/app/settings/organization/page.tsx`

Effects:

- Personal profile settings remain available.
- Organization settings are admin-only.
- The settings sidebar marks organization "General" as admin-only.
- MCP server authentication details and MCP API key notes are hidden unless the
  user can manage MCP servers.

## Related OAuth and Isolation Fixes

The same customization set also includes fixes that are adjacent to role and
tenant isolation.

### OAuth token cache is connector-scoped

Changed `packages/backend/src/mcp-server/dynamic-mcp-tools.ts`.

Effects:

- Dynamic MCP tool cache keys now include `connectorId`.
- REST engine execution receives `connectorId`.
- This prevents two connectors with the same tool name and parameters from
  sharing cached output or OAuth token state accidentally.

Tests added in:

- `packages/backend/src/mcp-server/dynamic-mcp-tools.spec.ts`

### OAuth token endpoint client auth supports `client_secret_basic`

Changed:

- `packages/backend/src/connectors/mcp-oauth.service.ts`
- `packages/backend/src/connectors/engines/oauth2-token.service.ts`
- `packages/backend/src/connectors/mcp-oauth-callback.controller.ts`

Effects:

- Authorization-code exchange and refresh-token flows support
  `tokenAuthMethod: "basic"` and `"client_secret_basic"`.
- Client credentials are sent using HTTP Basic auth when required, instead of
  being sent in the request body.
- Client id/secret are percent-encoded before base64 as required by OAuth2
  client-secret basic auth.
- OAuth callbacks preserve existing static auth settings and runtime refresh
  token state instead of replacing the whole auth config.
- Callback errors log provider status/body for easier diagnosis.

Tests updated in:

- `packages/backend/src/connectors/mcp-oauth.service.spec.ts`
- `packages/backend/src/connectors/engines/oauth2-token.service.spec.ts`

## Current Limitations

These changes lock down existing admin surfaces, but they do not yet implement
the intended non-admin connector authorization product flow.

Still missing:

- a sanitized "My Connections" page;
- an API that returns only connectors assigned to the current user;
- an assignment model linking connectors to users or MCP roles for
  authorization;
- per-user OAuth/API-key storage separate from admin-managed connector
  definitions;
- runtime credential resolution by `(connectorId, userId)` for user-owned
  authorizations.

See `docs/non-admin-connector-authorization-assessment.md` for the original
assessment and proposed next design.

## Verification

Relevant test coverage in this branch:

- adapter import rejects `EDITOR` and `VIEWER`;
- connector creation/import rejects `EDITOR` and `VIEWER`;
- OAuth client-secret-basic exchange and refresh behavior;
- connector-scoped dynamic tool execution/cache behavior.

Recommended checks before release:

```bash
npx tsc --noEmit -p packages/backend
NODE_OPTIONS=--localstorage-file=/tmp/anythingmcp-jest-localstorage \
  npm test --workspace=packages/backend -- --runInBand \
  adapters.controller.spec.ts \
  connectors.controller.spec.ts \
  mcp-oauth.service.spec.ts \
  engines/oauth2-token.service.spec.ts \
  mcp-server/dynamic-mcp-tools.spec.ts
```

Verification performed on 2026-07-31:

- `npx tsc --noEmit -p packages/backend` passed.
- Initial Jest run without `NODE_OPTIONS=--localstorage-file=...` failed before
  executing tests because Node 26 requires an explicit localStorage file path.
- With `NODE_OPTIONS=--localstorage-file=/tmp/anythingmcp-jest-localstorage`,
  four suites passed:
  - `adapters.controller.spec.ts`
  - `connectors.controller.spec.ts`
  - `mcp-oauth.service.spec.ts`
  - `engines/oauth2-token.service.spec.ts`
- `mcp-server/dynamic-mcp-tools.spec.ts` failed five Microsoft Graph attachment
  tests. The current implementation still returns attachment `contentBytes` as
  JSON text for those cases instead of decoding text, returning MCP image
  blocks, or saving unsupported binaries to disk. That attachment behavior is a
  separate unfinished fix; it is not required for the admin-only UI/API access
  control changes documented above.
