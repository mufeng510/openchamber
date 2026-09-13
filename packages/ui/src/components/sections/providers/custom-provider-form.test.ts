import { describe, expect, test } from 'bun:test';
import {
  addDiscoveredModelsToForm,
  buildAuthSetRequest,
  buildModelDiscoveryRequest,
  buildProviderUpsertRequest,
  discoveryErrorCodeFromPayload,
  discoveryErrorI18nKey,
  initialDiscoverySelection,
  isConfigDefinedCustomProvider,
  isCustomOpenAICompatibleProvider,
  parseDiscoverableModels,
  providerToCustomFormState,
  resolveProviderConfigScope,
  validateCustomProvider,
  type CustomProviderConfig,
  type CustomProviderFormState,
} from './custom-provider-form';

const t = (key: string) => key;

const baseForm = (overrides: Partial<CustomProviderFormState> = {}): CustomProviderFormState => ({
  providerID: 'custom-provider',
  name: 'Custom Provider',
  protocol: 'openai-chat',
  baseURL: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: [{ row: 'm0', id: 'model-a', name: 'Model A' }],
  headers: [{ row: 'h0', key: '', value: '' }],
  ...overrides,
});

/** Mirrors server upsert semantics for request-construction tests. */
function mergeProviderConfig(
  existing: Record<string, unknown>,
  providerID: string,
  config: CustomProviderConfig,
): Record<string, unknown> {
  const providerSection = (
    typeof existing.provider === 'object' && existing.provider !== null && !Array.isArray(existing.provider)
      ? { ...(existing.provider as Record<string, unknown>) }
      : {}
  );
  providerSection[providerID] = config;
  const next: Record<string, unknown> = {
    ...existing,
    provider: providerSection,
  };
  if (Array.isArray(existing.disabled_providers)) {
    next.disabled_providers = existing.disabled_providers.filter((entry) => entry !== providerID);
  }
  return next;
}

describe('validateCustomProvider', () => {
  test('builds trimmed config and auth payloads', () => {
    const result = validateCustomProvider({
      form: baseForm({
        providerID: ' custom-provider ',
        name: ' Custom Provider ',
        baseURL: ' https://api.example.com/v1 ',
        apiKey: ' sk-secret ',
        models: [{ row: 'm0', id: ' model-a ', name: ' Model A ' }],
        headers: [
          { row: 'h0', key: ' X-Test ', value: ' enabled ' },
          { row: 'h1', key: '', value: '' },
        ],
      }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result).toEqual({
      providerID: 'custom-provider',
      name: 'Custom Provider',
      apiKey: 'sk-secret',
      config: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Custom Provider',
        options: {
          baseURL: 'https://api.example.com/v1',
          headers: {
            'X-Test': 'enabled',
          },
        },
        models: {
          'model-a': { name: 'Model A' },
        },
      },
    });
  });

  test('supports {env:VAR} credentials without writing an auth key', () => {
    const result = validateCustomProvider({
      form: baseForm({
        apiKey: '{env: CUSTOM_PROVIDER_KEY}',
      }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result?.apiKey).toEqual(undefined);
    expect(result.result?.config.env).toEqual(['CUSTOM_PROVIDER_KEY']);
  });

  test('uses the selected OpenCode provider adapter', () => {
    const result = validateCustomProvider({
      form: baseForm({ protocol: 'openai-responses' }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result?.config.npm).toBe('@ai-sdk/openai');
  });

  test('rejects missing credentials', () => {
    const result = validateCustomProvider({
      form: baseForm({ apiKey: '   ' }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result).toEqual(undefined);
    expect(result.err.apiKey).toBe('settings.providers.page.custom.error.apiKey.required');
  });

  test('allows empty api key when editing with existing auth', () => {
    const result = validateCustomProvider({
      form: baseForm({ apiKey: '' }),
      t,
      existingProviderIDs: new Set(['custom-provider']),
      editingProviderID: 'custom-provider',
      allowExistingAuth: true,
    });

    expect(result.result?.providerID).toBe('custom-provider');
    expect(result.err.apiKey).toEqual(undefined);
    expect(result.result?.apiKey).toEqual(undefined);
  });

  test('rejects invalid provider id, base URL, and duplicate rows', () => {
    const result = validateCustomProvider({
      form: baseForm({
        providerID: 'Bad ID',
        baseURL: 'ftp://example.com',
        models: [
          { row: 'm0', id: 'model-a', name: 'Model A' },
          { row: 'm1', id: 'model-a', name: 'Model A 2' },
        ],
        headers: [
          { row: 'h0', key: 'Authorization', value: 'one' },
          { row: 'h1', key: 'authorization', value: 'two' },
        ],
      }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result).toEqual(undefined);
    expect(result.err.providerID).toBe('settings.providers.page.custom.error.providerID.format');
    expect(result.err.baseURL).toBe('settings.providers.page.custom.error.baseURL.format');
    expect(result.models[1]).toEqual({
      id: 'settings.providers.page.custom.error.duplicate',
      name: undefined,
    });
    expect(result.headers[1]).toEqual({
      key: 'settings.providers.page.custom.error.duplicate',
      value: undefined,
    });
  });

  test('allows reconnecting a disabled provider id', () => {
    const result = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(['custom-provider']),
      disabledProviders: ['custom-provider'],
    });

    expect(result.result?.providerID).toBe('custom-provider');
    expect(result.err.providerID).toEqual(undefined);
  });

  test('rejects an already-connected provider id on create', () => {
    const result = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(['custom-provider']),
    });

    expect(result.result).toEqual(undefined);
    expect(result.err.providerID).toBe('settings.providers.page.custom.error.providerID.exists');
  });

  test('allows updating the same provider id while editing', () => {
    const result = validateCustomProvider({
      form: baseForm({ apiKey: 'sk-updated' }),
      t,
      existingProviderIDs: new Set(['custom-provider']),
      editingProviderID: 'custom-provider',
    });

    expect(result.result?.providerID).toBe('custom-provider');
    expect(result.err.providerID).toEqual(undefined);
  });
});

describe('request construction', () => {
  test('builds auth.set and provider upsert requests', () => {
    const validated = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(),
    });
    const plan = validated.result!;

    expect(buildAuthSetRequest(plan)).toEqual({
      providerID: 'custom-provider',
      auth: { type: 'api', key: 'sk-test' },
    });
    expect(buildProviderUpsertRequest(plan)).toEqual({
      providerID: 'custom-provider',
      config: plan.config,
      scope: 'user',
    });
  });

  test('includes explicit project/custom scope on upsert requests', () => {
    const validated = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(),
    });
    const plan = validated.result!;

    expect(buildProviderUpsertRequest(plan, { scope: 'project' }).scope).toBe('project');
    expect(buildProviderUpsertRequest(plan, { scope: 'custom' }).scope).toBe('custom');
  });

  test('omits auth.set when using env credentials', () => {
    const validated = validateCustomProvider({
      form: baseForm({ apiKey: '{env:MY_KEY}' }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(buildAuthSetRequest(validated.result!)).toBeNull();
  });
});

describe('mergeProviderConfig persistence shape', () => {
  test('merges provider block and clears disabled_providers entry', () => {
    const validated = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(),
    });
    const plan = validated.result!;

    const next = mergeProviderConfig(
      {
        model: 'openai/gpt-4o',
        provider: {
          openai: { name: 'OpenAI' },
        },
        disabled_providers: ['custom-provider', 'other'],
      },
      plan.providerID,
      plan.config,
    );

    expect(next).toEqual({
      model: 'openai/gpt-4o',
      provider: {
        openai: { name: 'OpenAI' },
        'custom-provider': plan.config,
      },
      disabled_providers: ['other'],
    });
  });

  test('creates provider section when missing', () => {
    const validated = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(),
    });
    const plan = validated.result!;

    const next = mergeProviderConfig({}, plan.providerID, plan.config);
    expect(next.provider).toEqual({
      'custom-provider': plan.config,
    });
  });
});

describe('provider edit helpers', () => {
  test('detects openai-compatible custom providers and prefills form state', () => {
    expect(isCustomOpenAICompatibleProvider({
      id: 'campus-llm',
      options: { baseURL: 'https://llm.example.edu/v1' },
      models: [],
    })).toBe(true);

    const state = providerToCustomFormState({
      id: 'campus-llm',
      name: 'Campus LLM',
      env: ['CAMPUS_KEY'],
      options: {
        baseURL: 'https://llm.example.edu/v1',
        headers: { 'X-Campus': '1' },
      },
      models: [{ id: 'fast', name: 'Fast' }],
    });

    expect(state.providerID).toBe('campus-llm');
    expect(state.name).toBe('Campus LLM');
    expect(state.baseURL).toBe('https://llm.example.edu/v1');
    expect(state.apiKey).toBe('{env:CAMPUS_KEY}');
    expect(state.protocol).toBe('openai-chat');
    expect(state.models[0]).toEqual({ row: state.models[0].row, id: 'fast', name: 'Fast' });
    expect(state.headers[0]).toEqual({ row: state.headers[0].row, key: 'X-Campus', value: '1' });
  });

  test('prefills the protocol from a custom provider model', () => {
    const state = providerToCustomFormState({
      id: 'responses-api',
      options: { baseURL: 'https://api.example.com/v1' },
      models: [{ id: 'gpt', name: 'GPT', api: { npm: '@ai-sdk/openai' } }],
    });

    expect(state.protocol).toBe('openai-responses');
  });

  test('requires a config-layer source before treating a provider as editable custom', () => {
    const catalogLike = {
      id: 'openai',
      options: { baseURL: 'https://api.openai.com/v1' },
      models: [{ id: 'gpt-4o', name: 'GPT-4o', api: { npm: '@ai-sdk/openai-compatible' } }],
    };

    expect(isCustomOpenAICompatibleProvider(catalogLike)).toBe(true);
    expect(isConfigDefinedCustomProvider(catalogLike, undefined)).toBe(false);
    expect(isConfigDefinedCustomProvider(catalogLike, {
      user: { exists: false },
      project: { exists: false },
      custom: { exists: false },
    })).toBe(false);
    expect(isConfigDefinedCustomProvider(catalogLike, {
      user: { exists: true },
      project: { exists: false },
    })).toBe(true);
  });

  test('resolveProviderConfigScope follows custom > project > user precedence', () => {
    expect(resolveProviderConfigScope(undefined)).toBe('user');
    expect(resolveProviderConfigScope({
      user: { exists: true },
      project: { exists: false },
      custom: { exists: false },
    })).toBe('user');
    expect(resolveProviderConfigScope({
      user: { exists: true },
      project: { exists: true },
      custom: { exists: false },
    })).toBe('project');
    expect(resolveProviderConfigScope({
      user: { exists: true },
      project: { exists: true },
      custom: { exists: true },
    })).toBe('custom');
    expect(resolveProviderConfigScope({
      user: { exists: false },
      project: { exists: false },
      custom: { exists: true },
    })).toBe('custom');
  });
});

describe('model discovery helpers', () => {
  test('buildModelDiscoveryRequest trims and includes optional credentials', () => {
    expect(buildModelDiscoveryRequest(baseForm(), { editingProviderId: 'custom-provider' })).toEqual({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      providerId: 'custom-provider',
    });

    expect(buildModelDiscoveryRequest(baseForm({ apiKey: '   ' }))).toEqual({
      baseURL: 'https://api.example.com/v1',
    });

    expect(buildModelDiscoveryRequest(baseForm({
      baseURL: ' https://api.example.com/v1 ',
      apiKey: '   ',
      headers: [{ row: 'h0', key: '', value: '' }],
    }))).toEqual({
      baseURL: 'https://api.example.com/v1',
    });
  });

  test('buildModelDiscoveryRequest carries configured headers', () => {
    expect(buildModelDiscoveryRequest(baseForm({
      headers: [{ row: 'h0', key: 'X-Campus', value: '1' }],
    }))).toEqual({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      headers: { 'X-Campus': '1' },
    });
  });

  test('parseDiscoverableModels normalizes the response list', () => {
    expect(parseDiscoverableModels({
      models: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b' },
        { id: ' model-a ' },
      ],
    })).toEqual([
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'model-b' },
    ]);
  });

  test('parseDiscoverableModels skips unknown entries and rejects bad payloads', () => {
    expect(parseDiscoverableModels({ models: [42, null, { name: 'No id' }, { id: '' }] })).toEqual([]);
    expect(() => parseDiscoverableModels(null)).toThrow('Invalid model discovery payload');
    expect(() => parseDiscoverableModels({ wrongKey: [] })).toThrow('Invalid model discovery payload');
  });

  test('preserves model ids with slashes, colons, dots, and dashes', () => {
    const discovered = parseDiscoverableModels({
      models: [
        { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
        { id: 'model:v2' },
        { id: 'foo.bar' },
        { id: 'foo-bar' },
      ],
    });
    expect(discovered.map((model) => model.id)).toEqual([
      'moonshotai/kimi-k3',
      'model:v2',
      'foo.bar',
      'foo-bar',
    ]);

    const next = addDiscoveredModelsToForm([], discovered, new Set(discovered.map((model) => model.id)));
    expect(next.map((model) => ({ id: model.id, name: model.name }))).toEqual([
      { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
      { id: 'model:v2', name: 'model:v2' },
      { id: 'foo.bar', name: 'foo.bar' },
      { id: 'foo-bar', name: 'foo-bar' },
    ]);
  });

  test('discoveryErrorI18nKey maps error codes to message keys', () => {
    expect(discoveryErrorI18nKey('URL_BLOCKED')).toBe(
      'settings.providers.page.custom.models.discovery.error.urlBlocked',
    );
    expect(discoveryErrorI18nKey('TIMEOUT')).toBe(
      'settings.providers.page.custom.models.discovery.error.timeout',
    );
    expect(discoveryErrorI18nKey('MADE_UP')).toBeNull();
    expect(discoveryErrorI18nKey(undefined)).toBeNull();
    expect(discoveryErrorI18nKey(42)).toBeNull();
  });

  test('discoveryErrorCodeFromPayload reads the route error body at the boundary', () => {
    expect(discoveryErrorCodeFromPayload({ error: 'nope', code: 'TIMEOUT' })).toBe('TIMEOUT');
    expect(discoveryErrorCodeFromPayload({ code: 'NOT_A_CODE' })).toBeUndefined();
    expect(discoveryErrorCodeFromPayload({ models: [] })).toBeUndefined();
    expect(discoveryErrorCodeFromPayload(null)).toBeUndefined();
    expect(discoveryErrorCodeFromPayload('boom')).toBeUndefined();
  });

  test('initialDiscoverySelection pre-checks models already in the form', () => {
    const form = baseForm({
      models: [
        { row: 'm0', id: 'model-a', name: 'Model A' },
        { row: 'm1', id: 'local-model', name: 'Local' },
      ],
    });
    const discovered = [
      { id: 'model-a', name: 'Model A' },
      { id: 'new-model', name: 'New' },
    ];

    expect([...initialDiscoverySelection(form, discovered)].sort()).toEqual(['model-a']);
    expect([...initialDiscoverySelection(baseForm({ models: [] }), discovered)]).toEqual([]);
  });

  test('addDiscoveredModelsToForm appends selected models and skips duplicates', () => {
    const current = [{ row: 'm0', id: 'model-a', name: 'Model A' }];
    const discovered = [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
      { id: 'model-c', name: 'Model C' },
    ];

    const next = addDiscoveredModelsToForm(current, discovered, new Set(['model-b', 'model-c']));
    expect(next.length).toBe(3);
    expect(next.map((model) => model.id)).toEqual(['model-a', 'model-b', 'model-c']);
    expect(next[1]?.name).toBe('Model B');
    expect(next[2]?.name).toBe('Model C');

    expect(addDiscoveredModelsToForm(current, discovered, new Set(['model-a']))).toBe(current);
    expect(addDiscoveredModelsToForm(current, discovered, new Set())).toBe(current);
  });
});
