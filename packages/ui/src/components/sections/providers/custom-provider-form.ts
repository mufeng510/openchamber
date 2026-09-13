/**
 * Custom provider form helpers.
 * Mirrors OpenCode web UI validation and request construction so a provider
 * can be defined from Settings without code changes.
 */
import { z } from 'zod';

export const CUSTOM_PROVIDER_PROTOCOLS = {
  'openai-chat': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  'anthropic-messages': '@ai-sdk/anthropic',
} as const;
export type CustomProviderProtocol = keyof typeof CUSTOM_PROVIDER_PROTOCOLS;
export type CustomProviderNpm = (typeof CUSTOM_PROVIDER_PROTOCOLS)[CustomProviderProtocol];
export const CUSTOM_PROVIDER_ID = '__custom_provider__';
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const ENV_KEY_PATTERN = /^\{env:([^}]+)\}$/;

export type CustomProviderTranslator = (
  key: string,
  vars?: Record<string, string | number | boolean>,
) => string;

export type ModelRow = {
  row: string;
  id: string;
  name: string;
};

export type HeaderRow = {
  row: string;
  key: string;
  value: string;
};

export type CustomProviderFormState = {
  providerID: string;
  name: string;
  protocol: CustomProviderProtocol;
  baseURL: string;
  apiKey: string;
  models: ModelRow[];
  headers: HeaderRow[];
};

export type FieldErrors = {
  providerID?: string;
  name?: string;
  baseURL?: string;
  apiKey?: string;
};

export type ModelFieldErrors = {
  id?: string;
  name?: string;
};

export type HeaderFieldErrors = {
  key?: string;
  value?: string;
};

export type CustomProviderConfig = {
  npm: CustomProviderNpm;
  name: string;
  env?: string[];
  options: {
    baseURL: string;
    headers?: Record<string, string>;
  };
  models: Record<string, { name: string }>;
};

export type CustomProviderPersistPlan = {
  providerID: string;
  name: string;
  /** Literal API key to send via auth.set; omitted when using {env:VAR} or empty. */
  apiKey?: string;
  config: CustomProviderConfig;
};

export type ValidateCustomProviderInput = {
  form: CustomProviderFormState;
  t: CustomProviderTranslator;
  existingProviderIDs: ReadonlySet<string>;
  disabledProviders?: readonly string[];
  /** When editing this provider id, treat it as an allowed update target. */
  editingProviderID?: string;
  /**
   * When true, empty apiKey is allowed because auth.json already has a credential
   * (edit path). Still requires env or key when false.
   */
  allowExistingAuth?: boolean;
};

export type ValidateCustomProviderResult = {
  err: FieldErrors;
  models: ModelFieldErrors[];
  headers: HeaderFieldErrors[];
  result?: CustomProviderPersistPlan;
};

export type ProviderLikeForCustomForm = {
  id: string;
  name?: string;
  env?: string[];
  options?: Record<string, unknown> | null;
  models?: Array<{ id?: string; name?: string; api?: { npm?: string } }> | Record<string, unknown>;
};

let rowCounter = 0;

const nextRow = (): string => `row-${rowCounter++}`;

export const createModelRow = (): ModelRow => ({
  row: nextRow(),
  id: '',
  name: '',
});

export const createHeaderRow = (): HeaderRow => ({
  row: nextRow(),
  key: '',
  value: '',
});

export const createEmptyCustomProviderForm = (): CustomProviderFormState => ({
  providerID: '',
  name: '',
  protocol: 'openai-chat',
  baseURL: '',
  apiKey: '',
  models: [createModelRow()],
  headers: [createHeaderRow()],
});

export const isHttpBaseURL = (value: string): boolean => BASE_URL_PATTERN.test(value.trim());

function protocolFromNpm(npm: string | undefined): CustomProviderProtocol {
  switch (npm) {
    case '@ai-sdk/openai':
      return 'openai-responses';
    case '@ai-sdk/anthropic':
      return 'anthropic-messages';
    default:
      return 'openai-chat';
  }
}

function parseEnvApiKey(apiKey: string): { env?: string; key?: string } {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return {};
  }
  const envMatch = trimmed.match(ENV_KEY_PATTERN);
  const env = envMatch?.[1]?.trim();
  if (env) {
    return { env };
  }
  return { key: trimmed };
}

export function isCustomOpenAICompatibleProvider(provider: ProviderLikeForCustomForm): boolean {
  const options = provider.options && typeof provider.options === 'object' ? provider.options : null;
  const baseURL = typeof options?.baseURL === 'string' ? options.baseURL.trim() : '';
  if (baseURL && BASE_URL_PATTERN.test(baseURL)) {
    return true;
  }

  const models = Array.isArray(provider.models)
    ? provider.models
    : (provider.models && typeof provider.models === 'object'
      ? Object.values(provider.models)
      : []);

  return models.some((model) => {
    if (!model || typeof model !== 'object') {
      return false;
    }
    const api = 'api' in model && model.api && typeof model.api === 'object'
      ? model.api as { npm?: unknown }
      : null;
    return typeof api?.npm === 'string' && new Set<string>(Object.values(CUSTOM_PROVIDER_PROTOCOLS)).has(api.npm);
  });
}

export type ProviderConfigSourcesLike = {
  user?: { exists?: boolean };
  project?: { exists?: boolean };
  custom?: { exists?: boolean };
};

export type ProviderConfigScope = 'user' | 'project' | 'custom';

/**
 * True when a provider both looks OpenAI-compatible-custom and is defined in a
 * user/project/custom OpenCode config layer. Catalog-only providers often share
 * the same npm/baseURL signals and must not get Edit / config overrides.
 */
export function isConfigDefinedCustomProvider(
  provider: ProviderLikeForCustomForm,
  sources: ProviderConfigSourcesLike | null | undefined,
): boolean {
  if (!sources) {
    return false;
  }
  const inConfigLayer = Boolean(
    sources.user?.exists || sources.project?.exists || sources.custom?.exists,
  );
  return inConfigLayer && isCustomOpenAICompatibleProvider(provider);
}

/**
 * Effective writable config layer for a provider, matching OpenCode merge
 * precedence: custom > project > user.
 */
export function resolveProviderConfigScope(
  sources: ProviderConfigSourcesLike | null | undefined,
): ProviderConfigScope {
  if (sources?.custom?.exists) {
    return 'custom';
  }
  if (sources?.project?.exists) {
    return 'project';
  }
  return 'user';
}

export function providerToCustomFormState(provider: ProviderLikeForCustomForm): CustomProviderFormState {
  const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
  const baseURL = typeof options.baseURL === 'string' ? options.baseURL : '';
  const headersRaw = options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)
    ? options.headers as Record<string, unknown>
    : {};
  const headerRows = Object.entries(headersRaw)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .map(([key, value]) => ({ row: nextRow(), key, value }));

  const modelEntries = Array.isArray(provider.models)
    ? provider.models
    : (provider.models && typeof provider.models === 'object'
      ? Object.entries(provider.models).map(([id, value]) => ({
          id,
          name: value && typeof value === 'object' && 'name' in value && typeof (value as { name?: unknown }).name === 'string'
            ? (value as { name: string }).name
            : id,
        }))
      : []);

  const models = modelEntries.length > 0
    ? modelEntries.map((model) => ({
        row: nextRow(),
        id: typeof model?.id === 'string' ? model.id : '',
        name: typeof model?.name === 'string' ? model.name : (typeof model?.id === 'string' ? model.id : ''),
      }))
    : [createModelRow()];

  const envName = Array.isArray(provider.env)
    ? provider.env.find((entry) => typeof entry === 'string' && entry.trim().length > 0)?.trim()
    : undefined;

  const modelWithApi = modelEntries.find(
    (model): model is { id?: string; name?: string; api?: { npm?: string } } => 'api' in model,
  );

  return {
    providerID: provider.id,
    name: typeof provider.name === 'string' && provider.name.trim() ? provider.name : provider.id,
    protocol: protocolFromNpm(modelWithApi?.api?.npm),
    baseURL,
    apiKey: envName ? `{env:${envName}}` : '',
    models,
    headers: headerRows.length > 0 ? headerRows : [createHeaderRow()],
  };
}

/**
 * Validates form input and builds the auth + OpenCode provider config payloads.
 */
export function validateCustomProvider(input: ValidateCustomProviderInput): ValidateCustomProviderResult {
  const providerID = input.form.providerID.trim();
  const name = input.form.name.trim();
  const baseURL = input.form.baseURL.trim();
  const { env, key } = parseEnvApiKey(input.form.apiKey);
  const disabledProviders = input.disabledProviders ?? [];
  const editingProviderID = input.editingProviderID?.trim();

  const idError = !providerID
    ? input.t('settings.providers.page.custom.error.providerID.required')
    : !PROVIDER_ID_PATTERN.test(providerID)
      ? input.t('settings.providers.page.custom.error.providerID.format')
      : undefined;

  const nameError = !name
    ? input.t('settings.providers.page.custom.error.name.required')
    : undefined;

  const urlError = !baseURL
    ? input.t('settings.providers.page.custom.error.baseURL.required')
    : !BASE_URL_PATTERN.test(baseURL)
      ? input.t('settings.providers.page.custom.error.baseURL.format')
      : undefined;

  const credentialsSatisfied = Boolean(env || key || (editingProviderID && input.allowExistingAuth && editingProviderID === providerID));
  const apiKeyError = credentialsSatisfied
    ? undefined
    : input.t('settings.providers.page.custom.error.apiKey.required');

  const disabled = disabledProviders.includes(providerID);
  const isSelfEdit = Boolean(editingProviderID && editingProviderID === providerID);
  const existsError = idError || isSelfEdit
    ? undefined
    : input.existingProviderIDs.has(providerID) && !disabled
      ? input.t('settings.providers.page.custom.error.providerID.exists')
      : undefined;

  const seenModels = new Set<string>();
  const modelErrors = input.form.models.map((model) => {
    const id = model.id.trim();
    const modelIdError = !id
      ? input.t('settings.providers.page.custom.error.required')
      : seenModels.has(id)
        ? input.t('settings.providers.page.custom.error.duplicate')
        : (() => {
            seenModels.add(id);
            return undefined;
          })();
    const modelNameError = !model.name.trim()
      ? input.t('settings.providers.page.custom.error.required')
      : undefined;
    return { id: modelIdError, name: modelNameError };
  });

  const modelsValid = modelErrors.every((entry) => !entry.id && !entry.name);
  const modelConfig = Object.fromEntries(
    input.form.models.map((model) => [model.id.trim(), { name: model.name.trim() }]),
  );

  const seenHeaders = new Set<string>();
  const headerErrors = input.form.headers.map((header) => {
    const headerKey = header.key.trim();
    const headerValue = header.value.trim();
    if (!headerKey && !headerValue) {
      return {};
    }
    const keyError = !headerKey
      ? input.t('settings.providers.page.custom.error.required')
      : seenHeaders.has(headerKey.toLowerCase())
        ? input.t('settings.providers.page.custom.error.duplicate')
        : (() => {
            seenHeaders.add(headerKey.toLowerCase());
            return undefined;
          })();
    const valueError = !headerValue
      ? input.t('settings.providers.page.custom.error.required')
      : undefined;
    return { key: keyError, value: valueError };
  });

  const headersValid = headerErrors.every((entry) => !entry.key && !entry.value);
  const headerConfig = buildHeaderConfig(input.form.headers);

  const err: FieldErrors = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
    apiKey: apiKeyError,
  };

  const ok = !idError && !existsError && !nameError && !urlError && !apiKeyError && modelsValid && headersValid;
  if (!ok) {
    return { err, models: modelErrors, headers: headerErrors };
  }

  return {
    err,
    models: modelErrors,
    headers: headerErrors,
    result: {
      providerID,
      name,
      apiKey: key,
      config: {
        npm: CUSTOM_PROVIDER_PROTOCOLS[input.form.protocol],
        name,
        ...(env ? { env: [env] } : {}),
        options: {
          baseURL,
          ...(Object.keys(headerConfig).length > 0 ? { headers: headerConfig } : {}),
        },
        models: modelConfig,
      },
    },
  };
}

export function buildHeaderConfig(headers: HeaderRow[]): Record<string, string> {
  return Object.fromEntries(
    headers
      .map((header) => ({ key: header.key.trim(), value: header.value.trim() }))
      .filter((header) => header.key && header.value)
      .map((header) => [header.key, header.value]),
  );
}

/**
 * Builds the OpenCode auth.set request body when a literal API key is present.
 */
export function buildAuthSetRequest(plan: CustomProviderPersistPlan): {
  providerID: string;
  auth: { type: 'api'; key: string };
} | null {
  if (!plan.apiKey) {
    return null;
  }
  return {
    providerID: plan.providerID,
    auth: { type: 'api', key: plan.apiKey },
  };
}

/**
 * Builds the OpenChamber provider upsert request body (config persistence).
 * `scope` selects the OpenCode config layer (user/project/custom). Create
 * defaults to user; edit must pass the provider's effective existing layer.
 */
export function buildProviderUpsertRequest(
  plan: CustomProviderPersistPlan,
  options?: { scope?: ProviderConfigScope },
): {
  providerID: string;
  config: CustomProviderConfig;
  scope: ProviderConfigScope;
} {
  return {
    providerID: plan.providerID,
    config: plan.config,
    scope: options?.scope ?? 'user',
  };
}

export type DiscoveredModel = {
  id: string;
  name: string;
};

export type DiscoveryErrorCode =
  | 'INVALID_URL'
  | 'URL_BLOCKED'
  | 'AUTH_FAILED'
  | 'ACCESS_DENIED'
  | 'ENDPOINT_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_RESPONSE'
  | 'PROVIDER_ERROR'
  | 'REDIRECT'
  | 'NETWORK_ERROR'
  | 'TIMEOUT';

export type ModelDiscoveryRequest = {
  baseURL: string;
  apiKey?: string;
  providerId?: string;
  headers?: Record<string, string>;
};

/**
 * Builds the model discovery request body. Credentials only travel to the
 * OpenChamber discovery route, which resolves them server-side; they are never
 * returned to the client. In edit mode the provider id is included so a blank
 * API key can fall back to the stored OpenCode auth.
 */
export function buildModelDiscoveryRequest(
  form: CustomProviderFormState,
  options?: { editingProviderId?: string },
): ModelDiscoveryRequest {
  const headerConfig = buildHeaderConfig(form.headers);
  const request: ModelDiscoveryRequest = { baseURL: form.baseURL.trim() };
  const apiKey = form.apiKey.trim();
  if (apiKey) request.apiKey = apiKey;
  if (options?.editingProviderId) request.providerId = options.editingProviderId;
  if (Object.keys(headerConfig).length > 0) request.headers = headerConfig;
  return request;
}

const trimmed = z.string().transform((value) => value.trim());

/**
 * One entry of the standard OpenAI-compatible `{models: [{id, name}]}` list.
 * Ids must survive, a missing or blank display name falls back to the id.
 */
const discoveredModelSchema = z.object({
  id: trimmed.pipe(z.string().min(1)),
  name: trimmed.optional(),
});

const discoverableModelsSchema = z.object({
  models: z.array(z.unknown()),
});

/**
 * Parses the discovery response at the boundary. Unknown entries are skipped
 * and a missing display name falls back to the model id.
 */
export function parseDiscoverableModels(payload: unknown): DiscoveredModel[] {
  const parsed = discoverableModelsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid model discovery payload');
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const entry of parsed.data.models) {
    const model = discoveredModelSchema.safeParse(entry);
    if (!model.success) continue;
    const { id, name } = model.data;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: name || id });
  }
  return models;
}

const discoveryErrorCodeSchema = z.enum([
  'INVALID_URL',
  'URL_BLOCKED',
  'AUTH_FAILED',
  'ACCESS_DENIED',
  'ENDPOINT_NOT_FOUND',
  'RATE_LIMITED',
  'BAD_RESPONSE',
  'PROVIDER_ERROR',
  'REDIRECT',
  'NETWORK_ERROR',
  'TIMEOUT',
]);

const DISCOVERY_ERROR_I18N_KEYS = {
  INVALID_URL: 'settings.providers.page.custom.models.discovery.error.invalidURL',
  URL_BLOCKED: 'settings.providers.page.custom.models.discovery.error.urlBlocked',
  AUTH_FAILED: 'settings.providers.page.custom.models.discovery.error.authFailed',
  ACCESS_DENIED: 'settings.providers.page.custom.models.discovery.error.accessDenied',
  ENDPOINT_NOT_FOUND: 'settings.providers.page.custom.models.discovery.error.endpointNotFound',
  RATE_LIMITED: 'settings.providers.page.custom.models.discovery.error.rateLimited',
  BAD_RESPONSE: 'settings.providers.page.custom.models.discovery.error.badResponse',
  PROVIDER_ERROR: 'settings.providers.page.custom.models.discovery.error.providerError',
  REDIRECT: 'settings.providers.page.custom.models.discovery.error.redirect',
  NETWORK_ERROR: 'settings.providers.page.custom.models.discovery.error.network',
  TIMEOUT: 'settings.providers.page.custom.models.discovery.error.timeout',
} satisfies Record<DiscoveryErrorCode, string>;

const discoveryErrorBodySchema = z.object({
  code: discoveryErrorCodeSchema.optional(),
});

/**
 * Extracts the discovery error code from the route's error body at the
 * boundary. Malformed or non-error bodies yield `undefined`.
 */
export function discoveryErrorCodeFromPayload(payload: unknown): DiscoveryErrorCode | undefined {
  const parsed = discoveryErrorBodySchema.safeParse(payload);
  return parsed.success ? parsed.data.code : undefined;
}

export function discoveryErrorI18nKey(code: unknown): string | null {
  const parsed = discoveryErrorCodeSchema.safeParse(code);
  return parsed.success ? DISCOVERY_ERROR_I18N_KEYS[parsed.data] : null;
}

/**
 * Models already present in the form start checked so a fetch and save never
 * silently drops them again.
 */
export function initialDiscoverySelection(
  form: CustomProviderFormState,
  discovered: DiscoveredModel[],
): Set<string> {
  const existingIds = new Set(form.models.map((model) => model.id.trim()).filter((id) => id.length > 0));
  return new Set(discovered.map((model) => model.id).filter((id) => existingIds.has(id)));
}

/**
 * Appends the selected discovered models to the form rows, skipping ids that
 * already exist so a discovered model never overwrites hand-edited entries.
 */
export function addDiscoveredModelsToForm(
  current: ModelRow[],
  discovered: DiscoveredModel[],
  selectedIds: ReadonlySet<string>,
): ModelRow[] {
  const presentIds = new Set(current.map((model) => model.id.trim()).filter((id) => id.length > 0));
  const added: ModelRow[] = [];
  for (const model of discovered) {
    if (!selectedIds.has(model.id) || presentIds.has(model.id)) {
      continue;
    }
    presentIds.add(model.id);
    added.push({ row: nextRow(), id: model.id, name: model.name });
  }
  if (added.length === 0) {
    return current;
  }
  return [...current, ...added];
}
