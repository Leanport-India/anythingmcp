# Non-Admin Connector Authorization Assessment

Date: 2026-07-24

## Goal

Create a specialized non-admin role where a user can only authorize specific admin-preconfigured connectors for their own account. Nothing related to server management, connector creation/configuration, adapters, marketplace, or tool editing should be visible or accessible.

## Executive Summary

The current implementation does not yet support that target cleanly.

There is an MCP role system, but it is primarily an invocation allowlist for MCP tools. It does not drive the web application navigation, connector catalog visibility, connector authorization UI, or connector/server management permissions.

As a result:

- Non-admin users still see broad app areas such as Connectors, Marketplace, MCP Servers, Knowledge Graph, Audit Log, and Settings.
- `EDITOR` users can create/import connectors and MCP servers.
- `VIEWER` users are blocked from some writes, but can still see organization connectors, servers, adapter catalog entries, and details.
- There is no first-class "assigned/preconfigured connectors I may authorize for my own account" surface.
- Connector credentials are currently connector-owned/org-level configuration, not clearly separated into admin-managed connector definitions plus per-user authorization grants.

## Current Permission Model

There are two different concepts:

- App role: `ADMIN`, `EDITOR`, `VIEWER`.
- MCP role: `users.mcpRoleId`, mapped to allowed MCP tool IDs.

The MCP role system is enforced during MCP tool exposure/invocation. In `RolesService.getAllowedToolIds`, admins and users without an MCP role get unrestricted access, while users with an MCP role get only the assigned tool IDs.

This is useful for tool execution, but it does not restrict the product UI or management APIs.

## Findings

### 1. Main navigation is role-blind

Severity: High for UX/security posture.

`packages/frontend/src/components/app-sidebar.tsx` defines a static `NAV` and renders all groups/items for all authenticated users. The current user is read, but only used for workspace/profile display, not for filtering navigation.

Evidence:

- Static nav includes `/connectors`, `/connectors/store`, `/mcp-server`, `/knowledge-graph`, `/knowledge-graph/skills`, `/analytics`, `/logs`, `/welcome`.
- Rendering maps every item without a role check.

Impact:

A specialized non-admin user will still see the exact management areas you want hidden. Even when backend rejects an action later, the UI communicates that these areas are part of the user's job surface.

Recommendation:

Introduce frontend capability helpers, for example:

- `canManageConnectors`
- `canViewConnectorAdmin`
- `canManageMcpServers`
- `canViewAudit`
- `canManageRoles`
- `canAuthorizeAssignedConnectors`

Then filter `NAV`, settings sections, page actions, and deep-link route rendering from capabilities rather than raw role strings scattered across components.

### 2. Connectors page exposes organization connector management

Severity: High.

`packages/frontend/src/app/connectors/page.tsx` loads all organization connectors through `connectors.list(token)` and exposes actions for health check, export, import, adapter browsing, add connector, import spec, and delete.

Evidence:

- The page fetches `connectors.list(token)`.
- It defines handlers for delete, spec import, full export, full import, and health check.
- Header actions include adapters and add connector.

Impact:

This is not compatible with a user who should only authorize assigned preconfigured connectors. The page reveals connector inventory, base URLs, connector types, tool counts, and admin workflows.

Recommendation:

Do not reuse `/connectors` for specialized users. Create a separate "My Connections" or "Authorized Apps" page that only lists admin-approved connector assignments for the current user and only exposes:

- connector name/icon
- authorization status for current user
- connect/reconnect/disconnect actions
- minimal instructions provided by admin

### 3. Adapter marketplace is globally visible and import-capable

Severity: High.

`packages/frontend/src/app/connectors/store/page.tsx` loads the full adapter catalog and lets the user import an adapter with credentials.

Backend `AdaptersPublicController.list()` is public by design. Authenticated `POST /api/adapters/:slug/import` only blocks `VIEWER`; `EDITOR` can import adapters.

Impact:

Specialized users can browse available integrations that were not preconfigured for them. If they are `EDITOR`, they can create new connectors from the catalog.

Recommendation:

For specialized non-admin users:

- Hide marketplace routes entirely.
- Backend should reject catalog detail/import unless the user has connector-admin capability.
- If catalog metadata must remain public for marketing, do not expose it inside the authenticated app for restricted users.

### 4. MCP server UI and API are too permissive for non-admins

Severity: High.

`packages/frontend/src/app/mcp-server/page.tsx` loads all MCP servers for the organization and exposes "New MCP Server".

Backend `McpServersController.create()` does not check `VIEWER` or `ADMIN`; it only checks license limits. Update/delete assignment paths block viewers and non-owners, but create is open to any authenticated role.

Impact:

A restricted user can see MCP server names, endpoints, assigned connector counts, API key counts, and can create a new MCP server. This directly violates the "nothing related to server" requirement.

Recommendation:

Make MCP server list/detail/create/update/delete admin-only or capability-gated. Specialized users should not see MCP server routes or endpoint URLs.

### 5. Connector backend APIs allow broad read access

Severity: Medium to High depending on data sensitivity.

`GET /api/connectors` returns all connectors in the current organization to any authenticated user. `GET /api/connectors/:id` allows any org member to read connector details.

Impact:

Even if the sidebar is hidden, a restricted user can still call the APIs directly and enumerate configured connectors. Depending on response shape, this may leak base URLs, auth type, config, env var key names/values, headers, and implementation details.

Recommendation:

Split connector APIs:

- Admin connector management APIs: admin/capability-gated.
- End-user authorization APIs: return only connectors explicitly assigned to the current user or their specialized role, with a sanitized response.

The sanitized shape should exclude base URL, headers, auth config, env var values, endpoint mappings, and full tool definitions unless explicitly needed for the user-facing consent text.

### 6. Connector write permissions are owner/editor-oriented, not admin-preconfigured

Severity: High.

`ConnectorsController.assertCanCreate()` only blocks `VIEWER`; `EDITOR` can create connectors. `assertCanWrite()` allows connector owners or admins, so an `EDITOR` can manage connectors they created. Tool write paths follow the same pattern through connector ownership.

Impact:

A non-admin role cannot be made "authorization-only" by assigning `EDITOR`. Using `VIEWER` blocks writes but still leaks visibility and does not provide a proper per-user authorization workflow.

Recommendation:

Add explicit capabilities instead of relying only on `ADMIN`/`EDITOR`/`VIEWER`. For the target role, the capability set should look like:

- allow: `connectorAuth.self.authorize`
- allow: `connectorAuth.self.revoke`
- deny: `connectors.readAdmin`
- deny: `connectors.create/update/delete`
- deny: `tools.readAdmin/create/update/delete/test`
- deny: `adapters.read/import`
- deny: `mcpServers.read/create/update/delete`
- deny: `roles/users/audit/kg/adminSettings`

### 7. MCP tool restrictions do not imply connector authorization restrictions

Severity: Medium.

The MCP role allowlist is based on tool IDs. It controls what tools an MCP client can see/call, but it does not define which connectors the user may authorize, which account credential should be used, or whether authorization is user-owned versus org-owned.

Impact:

Admin can assign tools, but cannot express "this user may OAuth-authorize Salesforce and Google Drive using their own account, and nothing else." Tool-level access alone is too late in the lifecycle; the user has already seen/configured connector surfaces.

Recommendation:

Introduce a connector authorization assignment model. Example:

- Admin creates connector template/definition.
- Admin assigns connector definition to role/user/group.
- User sees only assigned connector definitions.
- User starts OAuth/API-key authorization for their own account.
- Runtime resolves credentials by `(connectorId, userId)` where applicable.
- Admin can see assignment and status, not necessarily user secrets.

### 8. Settings partially gates admin sections, but Profile leaks MCP/server concepts

Severity: Low to Medium.

`packages/frontend/src/app/settings/layout.tsx` hides Users, Roles, License, and Administration from non-admins. This is good.

However, `/settings` itself shows "MCP Server Authentication", OAuth endpoints, legacy auth mode, and an MCP API keys note that points users back to MCP Servers.

Impact:

Even a restricted user still sees server/auth implementation details.

Recommendation:

For specialized users, show only profile/password/account settings. Hide MCP authentication and MCP API key information unless the user can manage MCP servers or API keys.

## Recommended Target Design

### Roles and Capabilities

Keep `ADMIN`, but introduce capability-based checks for product areas. Treat current `EDITOR` and `VIEWER` as presets, not as the only authorization primitive.

Suggested new preset:

`CONNECTOR_AUTH_USER`

Capabilities:

- Can view assigned connector authorization cards.
- Can start/retry OAuth for assigned connectors.
- Can add/update/revoke their own credential grant if the connector supports per-user auth.
- Cannot view connector implementation details.
- Cannot browse adapter marketplace.
- Cannot create/import/update/delete connectors.
- Cannot view/create/update/delete tools.
- Cannot view/create/update/delete MCP servers or API keys.
- Cannot view audit logs, analytics, knowledge graph, users, roles, license, admin settings.

### Data Model Additions

Consider adding:

- `connector_authorization_assignments`
  - `id`
  - `organizationId`
  - `connectorId`
  - `roleId` or `userId`
  - `enabled`
  - `createdBy`

- `user_connector_authorizations`
  - `id`
  - `organizationId`
  - `connectorId`
  - `userId`
  - `status`
  - encrypted credential/token material
  - timestamps

For OAuth connectors, the admin-owned connector should store client/app configuration. The user-owned authorization should store the resulting access/refresh token for that user.

### API Shape

Add end-user APIs:

- `GET /api/me/connector-authorizations`
- `POST /api/me/connector-authorizations/:connectorId/oauth/authorize`
- `DELETE /api/me/connector-authorizations/:connectorId`

These should return sanitized connector data only.

Keep management APIs capability-gated:

- `/api/connectors/*`
- `/api/connectors/:id/tools/*`
- `/api/adapters/:slug/import`
- `/api/mcp-servers/*`
- `/api/roles/*`

### Frontend Routes

For specialized users, the sidebar should show only:

- My Connections
- Profile

Optional:

- Dashboard, if it is redesigned to show only their personal authorization state and no org/server/tool inventory.

All restricted routes should render a clear 403/Not Found state even on direct URL navigation.

## Suggested Implementation Order

1. Add shared frontend capability helpers and hide restricted navigation/actions.
2. Add backend capability guards for connector, adapter, tool, MCP server, audit, analytics, and knowledge graph APIs.
3. Create the end-user "My Connections" page and sanitized API.
4. Add assignment model linking admin-preconfigured connectors to users/roles.
5. Move OAuth/token storage for user-authorized connectors into a per-user authorization table.
6. Add tests:
   - non-admin cannot see restricted nav
   - non-admin direct routes are blocked
   - non-admin API calls to management endpoints return 403
   - assigned connector appears on My Connections
   - unassigned connector is absent and cannot be authorized
   - MCP tool listing remains filtered by MCP role/tool assignment

## Key Risk

The largest design risk is conflating "can invoke this MCP tool" with "can manage or authorize this connector." They are related, but they happen at different layers. The specialized role needs a connector authorization layer in addition to the existing MCP tool allowlist.

