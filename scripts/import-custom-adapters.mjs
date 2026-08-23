#!/usr/bin/env node
/**
 * Import local adapter JSON files into a deployed AnythingMCP instance without
 * adding them to the built-in catalog.
 *
 * Required:
 *   AMCP_BASE_URL=https://your-anythingmcp.example
 *   AMCP_TOKEN=...                                  OR
 *   AMCP_EMAIL=admin@example.com AMCP_PASSWORD=...
 *
 * Optional:
 *   AMCP_ADAPTER_MANIFEST=scripts/custom-adapters.manifest.json
 *   AMCP_ADAPTERS=path/a.json,path/b.json
 *   AMCP_DRY_RUN=1
 *
 * Adapter template placeholders like {{MICROSOFT_GRAPH_CLIENT_ID}} are resolved
 * from this process' environment before the connector is created/updated.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_MANIFEST = join(REPO_ROOT, 'scripts/custom-adapters.manifest.json');

const REQUIRED_CONNECTOR_FIELDS = ['name', 'type', 'baseUrl'];
const REQUIRED_TOOL_FIELDS = ['name', 'description', 'endpointMapping'];

function usage() {
  console.log(`
Usage:
  AMCP_BASE_URL=http://localhost:4000 \\
  AMCP_EMAIL=admin@example.com \\
  AMCP_PASSWORD='...' \\
  MICROSOFT_GRAPH_TENANT_ID=... \\
  MICROSOFT_GRAPH_CLIENT_ID=... \\
  MICROSOFT_GRAPH_CLIENT_SECRET=... \\
  node scripts/import-custom-adapters.mjs

Environment:
  AMCP_BASE_URL              Backend base URL, for example http://localhost:4000
  AMCP_TOKEN                 Existing JWT bearer token. Skips login when set.
  AMCP_EMAIL/AMCP_PASSWORD   Login credentials used when AMCP_TOKEN is omitted.
  AMCP_ADAPTER_MANIFEST      Manifest JSON with {"adapters":["path.json"]}.
  AMCP_ADAPTERS              Comma-separated adapter JSON paths. Overrides manifest.
  AMCP_DRY_RUN=1             Print planned imports without calling the API.
`);
}

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    die(`failed to read JSON at ${path}: ${err.message}`);
  }
}

function resolveRepoPath(path) {
  return isAbsolute(path) ? path : join(REPO_ROOT, path);
}

function adapterPaths() {
  if (process.env.AMCP_ADAPTERS) {
    return process.env.AMCP_ADAPTERS.split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map(resolveRepoPath);
  }

  const manifestPath = resolveRepoPath(
    process.env.AMCP_ADAPTER_MANIFEST || DEFAULT_MANIFEST,
  );
  if (!existsSync(manifestPath)) {
    die(`manifest not found: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  if (!Array.isArray(manifest.adapters) || manifest.adapters.length === 0) {
    die(`manifest must contain a non-empty "adapters" array: ${manifestPath}`);
  }

  return manifest.adapters.map(resolveRepoPath);
}

function interpolate(value, sourceLabel) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
      const envValue = process.env[key];
      if (envValue === undefined) {
        die(`${sourceLabel} requires environment variable ${key}`);
      }
      return envValue;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, sourceLabel));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolate(item, sourceLabel),
      ]),
    );
  }

  return value;
}

function toConnectorPayload(adapter, path) {
  if (!adapter.connector || typeof adapter.connector !== 'object') {
    die(`${path} is missing connector config`);
  }

  for (const field of REQUIRED_CONNECTOR_FIELDS) {
    if (!adapter.connector[field]) {
      die(`${path} connector is missing required field "${field}"`);
    }
  }

  if (!Array.isArray(adapter.tools) || adapter.tools.length === 0) {
    die(`${path} must contain at least one tool`);
  }

  adapter.tools.forEach((tool, index) => {
    for (const field of REQUIRED_TOOL_FIELDS) {
      if (!tool[field]) {
        die(`${path} tool #${index + 1} is missing required field "${field}"`);
      }
    }
  });

  const connector = interpolate(adapter.connector, path);

  return {
    adapterSlug: adapter.slug,
    adapterName: adapter.name,
    connector: {
      name: connector.name,
      type: connector.type,
      baseUrl: connector.baseUrl,
      authType: connector.authType || 'NONE',
      authConfig: connector.authConfig,
      headers: connector.headers,
      config: {
        ...(connector.config || {}),
        customAdapterSlug: adapter.slug,
        customAdapterName: adapter.name,
        customAdapterSource: path.replace(`${REPO_ROOT}/`, ''),
      },
      envVars: connector.envVars,
      instructions: adapter.instructions,
      isActive: true,
    },
    tools: adapter.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {} },
      endpointMapping: tool.endpointMapping,
      responseMapping: tool.responseMapping,
      outputSchema: tool.outputSchema ?? null,
      isEnabled: tool.isEnabled ?? true,
    })),
  };
}

async function apiFetch(path, options = {}) {
  const baseUrl = (process.env.AMCP_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) die('AMCP_BASE_URL is required');

  const url = `${baseUrl}${path}`;
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
  };

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const detail =
      typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${detail}`);
  }

  return data;
}

async function getToken() {
  if (process.env.AMCP_TOKEN) return process.env.AMCP_TOKEN;

  const email = process.env.AMCP_EMAIL;
  const password = process.env.AMCP_PASSWORD;
  if (!email || !password) {
    die('set AMCP_TOKEN or AMCP_EMAIL + AMCP_PASSWORD');
  }

  const result = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });

  if (!result?.accessToken) {
    die('login response did not contain accessToken');
  }
  return result.accessToken;
}

function sameName(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

async function upsertConnector(item, token) {
  const existing = await apiFetch('/api/connectors?limit=200', { token });
  const list = Array.isArray(existing) ? existing : existing?.items || [];
  const match = list.find((connector) => sameName(connector.name, item.connector.name));

  if (match) {
    const updated = await apiFetch(`/api/connectors/${match.id}`, {
      method: 'PUT',
      token,
      body: item.connector,
    });
    return { connector: updated, action: 'updated' };
  }

  const created = await apiFetch('/api/connectors', {
    method: 'POST',
    token,
    body: item.connector,
  });
  return { connector: created, action: 'created' };
}

async function importTools(connectorId, tools, token) {
  return apiFetch(`/api/connectors/${connectorId}/import`, {
    method: 'POST',
    token,
    body: {
      source: 'json',
      content: JSON.stringify({ tools }),
    },
  });
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const paths = adapterPaths();
  const items = paths.map((path) => {
    if (!existsSync(path)) die(`adapter file not found: ${path}`);
    return toConnectorPayload(readJson(path), path);
  });

  console.log(`Prepared ${items.length} custom adapter import(s):`);
  for (const item of items) {
    console.log(`- ${item.adapterName} -> ${item.connector.name} (${item.tools.length} tools)`);
  }

  if (process.env.AMCP_DRY_RUN === '1') {
    console.log('Dry run only; no API calls were made.');
    return;
  }

  const token = await getToken();
  for (const item of items) {
    const { connector, action } = await upsertConnector(item, token);
    const result = await importTools(connector.id, item.tools, token);
    const created = result?.created ?? result?.tools?.length ?? 0;
    const skipped = Array.isArray(result?.skipped)
      ? result.skipped.length
      : result?.skipped ?? 0;
    console.log(
      `${action}: ${item.connector.name} (${created} tools created/updated, ${skipped} skipped)`,
    );
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
