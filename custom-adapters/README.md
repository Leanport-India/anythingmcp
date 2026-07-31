# Custom adapters

The custom adapters that used to live in this directory have been moved back
into the normal built-in adapter catalog.

Current locations:

| Adapter | Location |
|---|---|
| Microsoft Graph Mail | `packages/backend/src/adapters/intl/microsoft-graph-mail.json` |
| Microsoft Graph Directory | `packages/backend/src/adapters/intl/microsoft-graph-directory.json` |
| DATEV Sandbox | `packages/backend/src/adapters/de/datev-sandbox.json` |
| DATEV Sandbox live test | `packages/backend/src/adapters/de/datev-sandbox.live.spec.ts` |

`packages/backend/src/adapters/catalog.ts` has been regenerated, so these
adapters are available through the regular AnythingMCP adapter UI/API. Users
can select the adapter and provide OAuth credentials during connector creation.

No DB/REST custom-adapter import is needed for these adapters right now.

If these adapters are moved out of the built-in catalog again later, update
`scripts/custom-adapters.manifest.json` and use
`scripts/import-custom-adapters.mjs` to import them as connector instances.
