# Custom adapters (not in upstream AnythingMCP)

This directory holds adapter definitions that exist only in this fork
(`Leanport-India/anythingmcp`) and do **not** exist in
`upstream` (`HelpCode-ai/anythingmcp`). They were originally added straight
into `packages/backend/src/adapters/{de,intl}/...` and wired into the
built-in catalog (`packages/backend/src/adapters/catalog.ts`), which meant
every future merge/rebase from upstream risked touching or conflicting with
these files.

They were pulled out on 2026-07-30 and moved here instead, so that:

- `packages/backend/src/adapters/` stays a clean mirror of upstream's adapter
  set — future `git merge upstream/main` / rebases won't hit conflicts here.
- These custom adapters still get added to a running instance, but via the
  **DB/REST importer script** (`scripts/import-custom-adapters.mjs`) instead
  of the static build-time catalog.

## What's here

| File | Originally at |
|---|---|
| `microsoft-graph-mail.json` | `packages/backend/src/adapters/intl/microsoft-graph-mail.json` |
| `microsoft-graph-directory.json` | `packages/backend/src/adapters/intl/microsoft-graph-directory.json` |
| `datev-sandbox.json` | `packages/backend/src/adapters/de/datev-sandbox.json` |
| `datev-sandbox.live.spec.ts` | `packages/backend/src/adapters/de/datev-sandbox.live.spec.ts` |

All 4 were added in commit `db89e46` ("added new adapters and other fixes"),
plus `datev-sandbox.json` originally landed earlier in `772fdf5`
("feat(connectors): DATEV sandbox adapter + reload REST tools after OAuth").
Moved with `git mv`, so file history (`git log --follow`) is preserved.

`datev-sandbox.live.spec.ts` is a live integration test tied to
`datev-sandbox.json` — it doesn't affect the catalog/build, it's kept
alongside the adapter JSON for convenience since it's meaningless without it.

**Stale generator, do not run**: `scripts/generate-datev-sandbox.mjs` (added
in `772fdf5`, the original small 6-tool sandbox adapter, since superseded by
the much larger version now in `custom-adapters/datev-sandbox.json`) derives
a *different, smaller* sandbox adapter from `de/datev.json` and would write
its output back to `packages/backend/src/adapters/de/datev-sandbox.json` —
the old, now-removed path. Left untouched, but do not run it expecting it to
regenerate or update `custom-adapters/datev-sandbox.json`; it doesn't know
this file moved and its output isn't the same adapter.

## What else changed

`packages/backend/src/adapters/catalog.ts` (an auto-generated file, see
`scripts/regenerate-catalog.mjs`) had the import + registry lines for these
3 adapters removed:

- 3 import lines (`datevSandbox`, `microsoftGraphDirectory`, `microsoftGraphMail`)
- 3 matching entries in the exported registry array

Verified via `tsc --noEmit` (clean) and a repo-wide grep that no other file
references these adapter slugs.

`scripts/custom-adapters.manifest.json` was updated to point at this
directory instead of the old in-tree paths:

```json
{
  "adapters": [
    "custom-adapters/microsoft-graph-directory.json",
    "custom-adapters/microsoft-graph-mail.json",
    "custom-adapters/datev-sandbox.json"
  ]
}
```

## The plan: verify the DB importer, then this directory becomes the only copy

`scripts/import-custom-adapters.mjs` creates/updates connectors + imports
their tools via the running backend's REST API (i.e. through the DB),
independent of `catalog.ts`. It reads adapter JSON off disk, resolves
`{{ENV_VAR}}` placeholders from the process environment, then:

- `POST /api/connectors` or `PUT /api/connectors/{id}` (upsert by name)
- `POST /api/connectors/{id}/import` (imports the adapter's tools)

**Before treating `catalog.ts`'s in-tree copies as removable / this move as
final**, confirm the importer can correctly recreate all 3 adapters end to
end against a real instance:

```bash
AMCP_BASE_URL=http://localhost:4000 \
AMCP_EMAIL=admin@example.com \
AMCP_PASSWORD='...' \
MICROSOFT_GRAPH_TENANT_ID=... \
MICROSOFT_GRAPH_CLIENT_ID=... \
MICROSOFT_GRAPH_CLIENT_SECRET=... \
DATEV_CLIENT_ID=... \
DATEV_CLIENT_SECRET=... \
node scripts/import-custom-adapters.mjs
```

(No `AMCP_ADAPTERS` override needed — the manifest above already points here.)

Dry run first, no API calls, just validates + prints the plan:

```bash
AMCP_DRY_RUN=1 node scripts/import-custom-adapters.mjs
```

Then in the AnythingMCP UI/API, verify for each of the 3 connectors:
- It was created (or updated) with the right `baseUrl`/`authConfig`/headers.
- Its tools imported (correct count, no `skipped` entries you didn't expect).
- The OAuth flow (`POST /api/connectors/{id}/oauth/authorize`) works for the
  Graph Mail / Graph Directory / DATEV Sandbox connectors, since all three
  are OAuth2.
- The connector actually calls through correctly (e.g. list clients / read
  mail / read directory).

Once that's confirmed working reliably, this `custom-adapters/` directory is
the durable source of truth for these 3 adapters going forward — no need to
put them back into `packages/backend/src/adapters/` or `catalog.ts`. Rerun
the importer (idempotent — it upserts by connector name) whenever you deploy
a fresh instance or these adapter definitions change.

## Reverting (only if the importer approach doesn't pan out)

If the DB-import approach turns out not to work and you need these back in
the static catalog:

```bash
cd /mnt/data/dockerprojects/anythingmcp

git mv custom-adapters/microsoft-graph-mail.json packages/backend/src/adapters/intl/
git mv custom-adapters/microsoft-graph-directory.json packages/backend/src/adapters/intl/
git mv custom-adapters/datev-sandbox.json packages/backend/src/adapters/de/
git mv custom-adapters/datev-sandbox.live.spec.ts packages/backend/src/adapters/de/
```

Then re-add these lines to `packages/backend/src/adapters/catalog.ts`:

```ts
// near the other ./de/*.json imports (alphabetical, after datev.json)
import * as datevSandbox from './de/datev-sandbox.json';

// near the other ./intl/*.json imports (alphabetical)
import * as microsoftGraphDirectory from './intl/microsoft-graph-directory.json';
import * as microsoftGraphMail from './intl/microsoft-graph-mail.json';
```

```ts
// in the exported registry array, same relative order as the imports
datevSandbox as unknown as AdapterDefinition,
microsoftGraphDirectory as unknown as AdapterDefinition,
microsoftGraphMail as unknown as AdapterDefinition,
```

And revert `scripts/custom-adapters.manifest.json` back to the in-tree paths.

Verify after reverting:

```bash
cd packages/backend && npx tsc --noEmit -p .
```
