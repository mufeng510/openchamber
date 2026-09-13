import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  ProviderDiscoveryError,
  assertDiscoveryUrlAllowed,
  buildModelsDiscoveryUrl,
  discoverProviderModels,
  normalizeDiscoveredModels,
  resolveDiscoveryApiKey,
} from './provider-models-discovery.js';

const jsonResponse = (payload, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => payload,
});

const noop = async () => {
  throw new Error('fetch should not have been called');
};

describe('buildModelsDiscoveryUrl', () => {
  test('appends /models to the base URL', () => {
    expect(buildModelsDiscoveryUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models');
    expect(buildModelsDiscoveryUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/models');
    expect(buildModelsDiscoveryUrl('http://llm.example.edu/')).toBe('http://llm.example.edu/models');
  });

  test('rejects non-http(s) schemes', () => {
    for (const url of ['ftp://api.example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(() => buildModelsDiscoveryUrl(url)).toThrow(ProviderDiscoveryError);
    }
  });
});

describe('assertDiscoveryUrlAllowed', () => {
  test('blocks loopback, private, link-local, and metadata targets by default', async () => {
    const blocked = [
      'https://127.0.0.1/test',
      'https://10.1.2.3/test',
      'https://192.168.1.5/test',
      'https://172.16.0.1/test',
      'https://100.64.0.1/test',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/test',
      'https://[fe80::1]/test',
      'https://localhost/test',
      'https://metadata.google.internal/test',
      'http://db.internal/',
      'https://api.local/',
    ];
    for (const url of blocked) {
      await expect(assertDiscoveryUrlAllowed(url, { lookup: noop })).rejects.toMatchObject({ code: 'URL_BLOCKED' });
    }
  });

  test('blocks embedded credentials in any mode', async () => {
    await expect(
      assertDiscoveryUrlAllowed('https://user:pass@api.example.com/test', { allowPrivate: true, lookup: noop }),
    ).rejects.toMatchObject({ code: 'URL_BLOCKED' });
  });

  test('allow private mode still blocks link-local and metadata addresses', async () => {
    const stillBlocked = [
      'https://169.254.169.254/latest/meta-data',
      'https://[fe80::1]/test',
      'https://metadata.google.internal/test',
    ];
    for (const url of stillBlocked) {
      await expect(
        assertDiscoveryUrlAllowed(url, { allowPrivate: true, lookup: noop }),
      ).rejects.toMatchObject({ code: 'URL_BLOCKED' });
    }
  });

  test('allow private mode permits loopback and LAN hosts', async () => {
    for (const url of ['https://127.0.0.1:11434/test', 'https://192.168.1.5/test', 'https://localhost/test']) {
      await expect(
        assertDiscoveryUrlAllowed(url, { allowPrivate: true, lookup: noop }),
      ).resolves.toBeUndefined();
    }
  });

  test('allows public hosts and does not fail when the hostname is unresolvable from tests', async () => {
    await expect(
      assertDiscoveryUrlAllowed('https://api.example.com/v1/models', { lookup: noop }),
    ).resolves.toBeUndefined();
  });

  test('blocks when the hostname resolves to a restricted address', async () => {
    const lookupPrivate = async () => [{ address: '10.0.0.7', family: 4 }];
    await expect(
      assertDiscoveryUrlAllowed('https://gateway.example.com/v1/models', { lookup: lookupPrivate }),
    ).rejects.toMatchObject({ code: 'URL_BLOCKED' });

    const lookupPublic = async () => [{ address: '8.8.8.8', family: 4 }];
    await expect(
      assertDiscoveryUrlAllowed('https://gateway.example.com/v1/models', { lookup: lookupPublic }),
    ).resolves.toBeUndefined();

    const lookupMixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }];
    await expect(
      assertDiscoveryUrlAllowed('https://gateway.example.com/v1/models', { lookup: lookupMixed }),
    ).rejects.toMatchObject({ code: 'URL_BLOCKED' });

    const lookupUnresolvable = async () => {
      const error = new Error('ENOTFOUND');
      throw error;
    };
    await expect(
      assertDiscoveryUrlAllowed('https://gateway.example.com/v1/models', { lookup: lookupUnresolvable }),
    ).resolves.toBeUndefined();
  });

  test('blocks numeric IPv4 spellings canonicalized to loopback by URL parser', async () => {
    const numericTargets = [
      'http://2130706433/models',           // 2^31 + 2^23 + 2^16 + 2^8 + 1
      'http://0x7f000001/models',           // hex
      'http://017700000001/models',         // octal
      'http://127.1/models',                // short dotted
    ];
    for (const url of numericTargets) {
      await expect(assertDiscoveryUrlAllowed(url, { lookup: noop })).rejects.toMatchObject({ code: 'URL_BLOCKED' });
    }
  });

  test('blocks IPv4-mapped IPv6 addresses that encode loopback and private ranges', async () => {
    const mappedTargets = [
      'http://[::ffff:127.0.0.1]/models',   // dotted
      'http://[::ffff:7f00:1]/models',      // hex  (loopback)
      'http://[::ffff:a00:1]/models',       // hex  (10.0.0.1)
    ];
    for (const url of mappedTargets) {
      await expect(assertDiscoveryUrlAllowed(url, { lookup: noop })).rejects.toMatchObject({ code: 'URL_BLOCKED' });
    }
  });
});

describe('normalizeDiscoveredModels', () => {
  test('parses the OpenAI-compatible { data } listing', () => {
    expect(normalizeDiscoveredModels({
      object: 'list',
      data: [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4o-mini' }],
    })).toEqual([
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
    ]);
  });

  test('parses a bare array listing', () => {
    expect(normalizeDiscoveredModels([{ id: 'a', name: 'A' }])).toEqual([{ id: 'a', name: 'A' }]);
  });

  test('skips invalid entries and deduplicates ids', () => {
    expect(normalizeDiscoveredModels({
      data: [
        { id: 'a', name: 'A' },
        { id: 'a', name: 'Duplicate' },
        { id: '' },
        null,
        { id: 'b' },
      ],
    })).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'b' },
    ]);
  });

  test('rejects a listing without models', () => {
    expect(() => normalizeDiscoveredModels({ data: 'nope' })).toThrow(ProviderDiscoveryError);
    expect(() => normalizeDiscoveredModels(null)).toThrow(ProviderDiscoveryError);
  });

  test('preserves model ids with slashes, colons, dots, and dashes', () => {
    expect(normalizeDiscoveredModels({
      data: [
        { id: 'moonshotai/kimi-k3' },
        { id: 'model:v2' },
        { id: 'foo.bar' },
        { id: 'foo-bar' },
      ],
    })).toEqual([
      { id: 'moonshotai/kimi-k3', name: 'moonshotai/kimi-k3' },
      { id: 'model:v2', name: 'model:v2' },
      { id: 'foo.bar', name: 'foo.bar' },
      { id: 'foo-bar', name: 'foo-bar' },
    ]);
  });
});

describe('resolveDiscoveryApiKey', () => {
  test('uses a literal key first', () => {
    expect(resolveDiscoveryApiKey({ apiKey: 'sk-literal', providerId: 'custom' })).toBe('sk-literal');
  });

  test('resolves {env:VAR} from the server environment', () => {
    expect(resolveDiscoveryApiKey({ apiKey: '{env:MISSING_VAR_XYZ}' })).toBeNull();
    process.env.DISCOVERY_TEST_ENV_KEY = 'sk-from-env';
    try {
      expect(resolveDiscoveryApiKey({ apiKey: '{env:DISCOVERY_TEST_ENV_KEY}' })).toBe('sk-from-env');
    } finally {
      delete process.env.DISCOVERY_TEST_ENV_KEY;
    }
  });

  test('falls back to stored auth for the edited provider', () => {
    const getStoredAuth = (providerId) =>
      providerId === 'custom' ? { type: 'api', key: 'sk-stored' } : null;
    expect(resolveDiscoveryApiKey({ providerId: 'custom', getStoredAuth })).toBe('sk-stored');
    expect(resolveDiscoveryApiKey({ providerId: 'unknown', getStoredAuth })).toBeNull();
  });
});

describe('discoverProviderModels', () => {
  const baseURL = 'https://api.example.com/v1';

  const capture = (payload, status = 200) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(payload, status);
    };
    return { fetchImpl, calls };
  };

  beforeEach(() => {
    delete process.env.DISCOVERY_TEST_ENV_KEY;
  });

  afterEach(() => {
    delete process.env.DISCOVERY_TEST_ENV_KEY;
  });

  test('fetches {baseURL}/models with bearer credentials', async () => {
    const { fetchImpl, calls } = capture({ data: [{ id: 'm1', name: 'M1' }] });
    const models = await discoverProviderModels({
      baseURL,
      apiKey: 'sk-test',
      fetchImpl,
      lookup: () => Promise.resolve([]),
    });

    expect(models).toEqual([{ id: 'm1', name: 'M1' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/v1/models');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-test');
  });

  test('resolves {env:VAR} credentials for the request', async () => {
    process.env.DISCOVERY_TEST_ENV_KEY = 'sk-from-env';
    const { fetchImpl, calls } = capture({ data: [] });
    await discoverProviderModels({
      baseURL,
      apiKey: '{env:DISCOVERY_TEST_ENV_KEY}',
      fetchImpl,
      lookup: () => Promise.resolve([]),
    });
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-from-env');
  });

  test('uses stored auth when editing and the key field is blank', async () => {
    const { fetchImpl, calls } = capture({ data: [{ id: 'm1' }] });
    const getStoredAuth = () => ({ type: 'api', key: 'sk-stored' });
    await discoverProviderModels({
      baseURL,
      providerId: 'custom',
      fetchImpl,
      getStoredAuth,
      lookup: () => Promise.resolve([]),
    });
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-stored');
  });

  test('sends no Authorization header when no credentials resolve', async () => {
    const { fetchImpl, calls } = capture({ data: [] });
    await discoverProviderModels({ baseURL, fetchImpl, lookup: () => Promise.resolve([]) });
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  test('forwards configured custom headers', async () => {
    const { fetchImpl, calls } = capture({ data: [] });
    await discoverProviderModels({
      baseURL,
      headers: { 'X-Campus': 'east' },
      fetchImpl,
      lookup: () => Promise.resolve([]),
    });
    expect(calls[0].init.headers['X-Campus']).toBe('east');
  });

  test('maps provider statuses to error codes', async () => {
    const cases = [
      [{ error: 'auth' }, 401, 'AUTH_FAILED', 401],
      [{ error: 'forbidden' }, 403, 'ACCESS_DENIED', 403],
      [{ error: 'missing' }, 404, 'ENDPOINT_NOT_FOUND', 404],
      [{ error: 'rate' }, 429, 'RATE_LIMITED', 429],
      [{ error: 'boom' }, 503, 'PROVIDER_ERROR', 502],
    ];
    for (const [payload, status, code] of cases) {
      await expect(
        discoverProviderModels({
          baseURL,
          fetchImpl: async () => jsonResponse(payload, status),
          lookup: () => Promise.resolve([]),
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  test('rejects redirects without following them', async () => {
    const fetchImpl = async (url) => ({
      status: 302,
      ok: false,
      headers: new Map([['location', 'https://evil.example.com/models']]),
      json: async () => ({}),
    });
    await expect(
      discoverProviderModels({ baseURL, fetchImpl, lookup: () => Promise.resolve([]) }),
    ).rejects.toMatchObject({ code: 'REDIRECT' });
  });

  test('surfaces timeouts and network failures distinctly', async () => {
    const timeout = async () => {
      throw { name: 'TimeoutError' };
    };
    await expect(
      discoverProviderModels({ baseURL, fetchImpl: timeout, lookup: () => Promise.resolve([]) }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });

    await expect(
      discoverProviderModels({
        baseURL,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
        lookup: () => Promise.resolve([]),
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  test('rejects non-JSON responses and invalid listings', async () => {
    await expect(
      discoverProviderModels({
        baseURL,
        fetchImpl: async () => ({ status: 200, ok: true, json: async () => {
          throw new Error('not json');
        } }),
        lookup: () => Promise.resolve([]),
      }),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });

    await expect(
      discoverProviderModels({
        baseURL,
        fetchImpl: async () => jsonResponse({ hello: 'there' }, 200),
        lookup: () => Promise.resolve([]),
      }),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  test('never fetches a blocked or invalid target', async () => {
    await expect(
      discoverProviderModels({ baseURL: 'ftp://api.example.com', fetchImpl: noop }),
    ).rejects.toMatchObject({ code: 'INVALID_URL' });

    for (const url of ['https://127.0.0.1:11434/v1', 'https://user:pass@api.example.com', 'https://localhost:11434']) {
      await expect(
        discoverProviderModels({ baseURL: url, fetchImpl: noop }),
      ).rejects.toMatchObject({ code: 'URL_BLOCKED' });
    }
  });

  test('allow private mode lets local model servers be discovered', async () => {
    const { fetchImpl, calls } = capture({ data: [{ id: 'local-model' }] });
    const models = await discoverProviderModels({
      baseURL: 'http://localhost:11434/v1',
      fetchImpl,
      allowPrivate: true,
      lookup: () => Promise.resolve([]),
    });
    expect(models).toEqual([{ id: 'local-model', name: 'local-model' }]);
    expect(calls[0].url).toBe('http://localhost:11434/v1/models');
  });
});