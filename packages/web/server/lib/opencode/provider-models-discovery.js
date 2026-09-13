import { getProviderAuth } from './auth.js';
import {
  canonicalizeDiscoveryHostname,
  classifyDiscoveryAddress,
  classifyDiscoveryHostname,
  hostnameResolvesToRestrictedAddress,
} from './provider-discovery-url-safety.js';

const DISCOVERY_TIMEOUT_MS = 10_000;
const MODELS_PATH = '/models';
const ENV_KEY_PATTERN = /^\{env:([^}]+)\}$/;

/**
 * Discovery failures carry a stable `code` so the route can pick an HTTP status
 * and the UI can map a localized message. `message` stays a safe English
 * fallback and never includes credentials.
 */
export class ProviderDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderDiscoveryError';
    this.code = code;
  }
}

const ERROR_STATUS = {
  INVALID_URL: 400,
  URL_BLOCKED: 400,
  AUTH_FAILED: 401,
  ACCESS_DENIED: 403,
  ENDPOINT_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  BAD_RESPONSE: 502,
  PROVIDER_ERROR: 502,
  REDIRECT: 502,
  NETWORK_ERROR: 502,
  TIMEOUT: 504,
};

export const discoveryErrorStatus = (code) => ERROR_STATUS[code] ?? 500;

/**
 * `{baseURL}/models`, trimming trailing slashes so a base URL that ends in `/`
 * does not produce a double slash. Query and fragment are dropped; the base URL
 * is an API root, not a request with parameters.
 */
export function buildModelsDiscoveryUrl(baseURL) {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    throw new ProviderDiscoveryError('INVALID_URL', 'Base URL is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderDiscoveryError('INVALID_URL', 'Base URL must use http:// or https://.');
  }
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${MODELS_PATH}`;
  return url.toString();
}

const readAllowPrivate = () => {
  const value = process.env.OPENCHAMBER_PROVIDER_DISCOVERY_ALLOW_PRIVATE;
  return value === '1' || value === 'true';
};

const normalizeDiscoveryHeaders = (headers) => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return {};
  }
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim()) {
      normalized[key.trim()] = value.trim();
    }
  }
  return normalized;
};

/**
 * Reject a discovery target outside the host policy. `metadata` endpoints and
 * link-local addresses stay blocked in every mode; loopback, LAN, and overlay
 * addresses are blocked unless allow-private is set.
 */
export async function assertDiscoveryUrlAllowed(endpoint, { allowPrivate = readAllowPrivate(), lookup } = {}) {
  const url = new URL(endpoint);
  if (url.username || url.password) {
    throw new ProviderDiscoveryError('URL_BLOCKED', 'Base URLs with embedded credentials are not allowed.');
  }

  // Canonicalize through the same parser fetch uses, so numeric/hex/shortened
  // IPv4 spellings (2130706433, 0x7f000001, 127.1) are classified as the real
  // dotted-quad address instead of passing as opaque hostnames.
  const hostname = canonicalizeDiscoveryHostname(url.hostname).toLowerCase();
  const literalKind = classifyDiscoveryAddress(hostname);
  if (literalKind === 'blocked' || (literalKind === 'private' && !allowPrivate)) {
    throw new ProviderDiscoveryError('URL_BLOCKED', 'The Base URL points to a restricted address.');
  }
  if (literalKind) {
    return;
  }

  const hostnameKind = classifyDiscoveryHostname(hostname);
  if (hostnameKind === 'blocked' || (hostnameKind === 'private' && !allowPrivate)) {
    throw new ProviderDiscoveryError('URL_BLOCKED', 'The Base URL points to a restricted host.');
  }

  const { resolved, restricted } = await hostnameResolvesToRestrictedAddress(hostname, { allowPrivate, lookup });
  if (resolved && restricted) {
    throw new ProviderDiscoveryError('URL_BLOCKED', 'The Base URL resolves to a restricted address.');
  }
}

/**
 * Credentials for the discovery GET, in order: a literal key, `{env:VAR}`
 * resolved from the server environment, then the stored OpenCode auth for the
 * provider being edited. A null result means no Authorization header, which
 * some self-hosted endpoints accept.
 */
export function resolveDiscoveryApiKey({ apiKey, providerId, getStoredAuth = getProviderAuth } = {}) {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (trimmed) {
    const envMatch = trimmed.match(ENV_KEY_PATTERN);
    if (envMatch) {
      const name = envMatch[1].trim();
      const value = name ? process.env[name] : undefined;
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    }
    return trimmed;
  }

  if (providerId) {
    const auth = getStoredAuth(providerId);
    const storedKey = auth && typeof auth.key === 'string' ? auth.key.trim() : '';
    if (storedKey) {
      return storedKey;
    }
  }
  return null;
}

/**
 * OpenAI-compatible listings look like `{ data: [{ id, name }] }`; a few
 * gateways return the array directly. Unknown entries are skipped, ids are
 * deduplicated, and a missing display name falls back to the id.
 */
export function normalizeDiscoveredModels(payload) {
  let entries;
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (payload && typeof payload === 'object' && Array.isArray(payload.data)) {
    entries = payload.data;
  } else {
    throw new ProviderDiscoveryError('BAD_RESPONSE', 'The provider did not return a model list.');
  }

  const seen = new Set();
  const models = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
    models.push({ id, name });
  }
  return models;
}

const isTimeoutError = (error) =>
  error?.name === 'TimeoutError' || error?.name === 'AbortError';

/**
 * Fetch the provider's model list. Only performs a GET against
 * `{baseURL}/models`; there is no caller-controlled path or method, so this is
 * a discovery probe rather than a general request proxy.
 */
export async function discoverProviderModels({
  baseURL,
  apiKey,
  providerId,
  headers,
  fetchImpl = globalThis.fetch,
  allowPrivate = readAllowPrivate(),
  getStoredAuth = getProviderAuth,
  lookup,
} = {}) {
  const endpoint = buildModelsDiscoveryUrl(baseURL);
  await assertDiscoveryUrlAllowed(endpoint, { allowPrivate, lookup });

  const requestHeaders = { Accept: 'application/json', ...normalizeDiscoveryHeaders(headers) };
  const resolvedKey = resolveDiscoveryApiKey({ apiKey, providerId, getStoredAuth });
  if (resolvedKey) {
    requestHeaders.Authorization = `Bearer ${resolvedKey}`;
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ProviderDiscoveryError('TIMEOUT', 'The provider did not respond in time.');
    }
    throw new ProviderDiscoveryError('NETWORK_ERROR', 'Could not reach the provider.');
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ProviderDiscoveryError('REDIRECT', 'The provider redirected the model request.');
  }
  if (response.status === 401) {
    throw new ProviderDiscoveryError('AUTH_FAILED', 'The provider rejected the credentials.');
  }
  if (response.status === 403) {
    throw new ProviderDiscoveryError('ACCESS_DENIED', 'The provider refused access.');
  }
  if (response.status === 404) {
    throw new ProviderDiscoveryError('ENDPOINT_NOT_FOUND', 'The model list was not found at this Base URL.');
  }
  if (response.status === 429) {
    throw new ProviderDiscoveryError('RATE_LIMITED', 'The provider is rate-limiting requests.');
  }
  if (!response.ok) {
    throw new ProviderDiscoveryError('PROVIDER_ERROR', `The provider returned status ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderDiscoveryError('BAD_RESPONSE', 'The provider did not return valid JSON.');
  }
  return normalizeDiscoveredModels(payload);
}
