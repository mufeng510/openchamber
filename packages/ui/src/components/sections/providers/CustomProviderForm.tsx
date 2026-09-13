import React from 'react';
import {
  SettingsSection,
  SettingsStackedField,
  SettingsCheckboxRow,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_CONTROL_CLUSTER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  addDiscoveredModelsToForm,
  buildModelDiscoveryRequest,
  CUSTOM_PROVIDER_PROTOCOLS,
  createEmptyCustomProviderForm,
  createHeaderRow,
  createModelRow,
  discoveryErrorI18nKey,
  discoveryErrorCodeFromPayload,
  initialDiscoverySelection,
  isHttpBaseURL,
  parseDiscoverableModels,
  validateCustomProvider,
  type CustomProviderFormState,
  type CustomProviderPersistPlan,
  type CustomProviderTranslator,
  type DiscoveredModel,
  type FieldErrors,
  type HeaderFieldErrors,
  type ModelFieldErrors,
} from './custom-provider-form';

type CustomProviderFormProps = {
  existingProviderIDs: ReadonlySet<string>;
  disabledProviders?: readonly string[];
  busy?: boolean;
  mode?: 'create' | 'edit';
  initialValues?: CustomProviderFormState;
  allowExistingAuth?: boolean;
  authFailureHint?: string | null;
  onSubmit: (plan: CustomProviderPersistPlan) => void | Promise<void>;
  onCancel?: () => void;
  onDisconnect?: () => void | Promise<void>;
};

export const CustomProviderForm: React.FC<CustomProviderFormProps> = ({
  existingProviderIDs,
  disabledProviders = [],
  busy = false,
  mode = 'create',
  initialValues,
  allowExistingAuth = false,
  authFailureHint = null,
  onSubmit,
  onCancel,
  onDisconnect,
}) => {
  const { t } = useI18n();
  const isEdit = mode === 'edit';
  const [form, setForm] = React.useState<CustomProviderFormState>(
    () => initialValues ?? createEmptyCustomProviderForm(),
  );
  const [err, setErr] = React.useState<FieldErrors>({});
  const [modelErrors, setModelErrors] = React.useState<ModelFieldErrors[]>([]);
  const [headerErrors, setHeaderErrors] = React.useState<HeaderFieldErrors[]>([]);
  const [discoveryBusy, setDiscoveryBusy] = React.useState(false);
  const [discoveryAttempted, setDiscoveryAttempted] = React.useState(false);
  const [discoveredModels, setDiscoveredModels] = React.useState<DiscoveredModel[]>([]);
  const [discoverySelection, setDiscoverySelection] = React.useState<ReadonlySet<string>>(() => new Set());
  const [discoveryError, setDiscoveryError] = React.useState<string | null>(null);
  const seededEditProviderIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!initialValues) {
      return;
    }
    // Edit mode: seed once per provider id so parent re-renders (new object
    // identity for the same snapshot) do not wipe in-progress edits.
    if (isEdit && seededEditProviderIdRef.current === initialValues.providerID) {
      return;
    }
    seededEditProviderIdRef.current = isEdit ? initialValues.providerID : null;
    setForm(initialValues);
    setErr({});
    setModelErrors([]);
    setHeaderErrors([]);
    setDiscoveryBusy(false);
    setDiscoveryAttempted(false);
    setDiscoveredModels([]);
    setDiscoverySelection(new Set());
    setDiscoveryError(null);
  }, [initialValues, isEdit]);

  const setField = (key: keyof Pick<CustomProviderFormState, 'providerID' | 'name' | 'baseURL' | 'apiKey'>, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErr((prev) => ({ ...prev, [key]: undefined }));
  };

  const setModel = (index: number, key: 'id' | 'name', value: string) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)),
    }));
    setModelErrors((prev) => {
      const next = [...prev];
      next[index] = { ...(next[index] ?? {}), [key]: undefined };
      return next;
    });
  };

  const setHeader = (index: number, key: 'key' | 'value', value: string) => {
    setForm((prev) => ({
      ...prev,
      headers: prev.headers.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)),
    }));
    setHeaderErrors((prev) => {
      const next = [...prev];
      next[index] = { ...(next[index] ?? {}), [key]: undefined };
      return next;
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }

    const output = validateCustomProvider({
      form,
      t: ((key, vars) => t(key as Parameters<typeof t>[0], vars)) as CustomProviderTranslator,
      existingProviderIDs,
      disabledProviders,
      editingProviderID: isEdit ? form.providerID : undefined,
      allowExistingAuth: isEdit && allowExistingAuth,
    });
    setErr(output.err);
    setModelErrors(output.models);
    setHeaderErrors(output.headers);
    if (!output.result) {
      return;
    }
    await onSubmit(output.result);
  };

  const handleFetchModels = async () => {
    if (discoveryBusy) {
      return;
    }
    const baseURL = form.baseURL.trim();
    if (!isHttpBaseURL(baseURL)) {
      setDiscoveryAttempted(true);
      setDiscoveryError(t('settings.providers.page.custom.models.discovery.requiresBaseURL'));
      return;
    }
    setDiscoveryBusy(true);
    setDiscoveryAttempted(true);
    setDiscoveryError(null);
    setDiscoveredModels([]);
    setDiscoverySelection(new Set());
    try {
      const response = await runtimeFetch('/api/provider/models/discover', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          buildModelDiscoveryRequest(form, { editingProviderId: isEdit ? form.providerID : undefined }),
        ),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const errorKey = discoveryErrorI18nKey(discoveryErrorCodeFromPayload(payload));
        setDiscoveryError(
          errorKey
            // SAFETY: errorKey is a string union produced by discoveryErrorCodeSchema; t() accepts the same key union.
            ? t(errorKey as Parameters<typeof t>[0])
            : t('settings.providers.page.custom.models.discovery.error.failed'),
        );
        return;
      }
      const models = parseDiscoverableModels(payload);
      setDiscoveredModels(models);
      setDiscoverySelection(initialDiscoverySelection(form, models));
    } catch (error) {
      console.error('Failed to discover provider models:', error);
      setDiscoveryError(t('settings.providers.page.custom.models.discovery.error.failed'));
    } finally {
      setDiscoveryBusy(false);
    }
  };

  const toggleDiscovered = (modelId: string, checked: boolean) => {
    setDiscoverySelection((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(modelId);
      } else {
        next.delete(modelId);
      }
      return next;
    });
  };

  const handleAddDiscovered = () => {
    const nextModels = addDiscoveredModelsToForm(form.models, discoveredModels, discoverySelection);
    setForm((prev) => ({ ...prev, models: nextModels }));
    setModelErrors((prev) => [
      ...prev,
      // SAFETY: empty record — a freshly added discovered model carries no validation errors yet.
      ...nextModels.slice(prev.length).map(() => ({} as ModelFieldErrors)),
    ]);
    setDiscoveredModels([]);
    setDiscoverySelection(new Set());
    setDiscoveryAttempted(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-0">
      <SettingsSection
        title={isEdit ? t('settings.providers.page.custom.editTitle') : t('settings.providers.page.custom.title')}
        divider={false}
        settingsItem="providers.custom"
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.providers.page.custom.description')}</p>

        {authFailureHint ? (
          <p className="typography-meta text-[var(--status-warning)]" role="status">
            {authFailureHint}
          </p>
        ) : null}

        <SettingsStackedField
          label={t('settings.providers.page.custom.field.providerID.label')}
          info={t('settings.providers.page.custom.field.providerID.info')}
        >
          <Input
            value={form.providerID}
            onChange={(event) => setField('providerID', event.target.value)}
            placeholder={t('settings.providers.page.custom.field.providerID.placeholder')}
            className="h-8 rounded-md px-3 font-mono text-xs"
            autoFocus={!isEdit}
            disabled={isEdit || busy}
            aria-invalid={Boolean(err.providerID)}
            aria-label={t('settings.providers.page.custom.field.providerID.label')}
          />
          {err.providerID ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.providerID}</p> : null}
        </SettingsStackedField>

        <SettingsStackedField
          label={t('settings.providers.page.custom.field.protocol.label')}
          info={t('settings.providers.page.custom.field.protocol.info')}
        >
          <Select
            value={form.protocol}
            onValueChange={(protocol) => {
              if (!(protocol in CUSTOM_PROVIDER_PROTOCOLS)) {
                return;
              }
              setForm((prev) => ({ ...prev, protocol }));
            }}
            disabled={busy}
          >
            <SelectTrigger aria-label={t('settings.providers.page.custom.field.protocol.label')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai-chat">{t('settings.providers.page.custom.field.protocol.openaiChat')}</SelectItem>
              <SelectItem value="openai-responses">{t('settings.providers.page.custom.field.protocol.openaiResponses')}</SelectItem>
              <SelectItem value="anthropic-messages">{t('settings.providers.page.custom.field.protocol.anthropicMessages')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsStackedField>

        <SettingsStackedField
          label={t('settings.providers.page.custom.field.name.label')}
          info={t('settings.providers.page.custom.field.name.info')}
        >
          <Input
            value={form.name}
            onChange={(event) => setField('name', event.target.value)}
            placeholder={t('settings.providers.page.custom.field.name.placeholder')}
            className="h-8 rounded-md px-3"
            aria-invalid={Boolean(err.name)}
            aria-label={t('settings.providers.page.custom.field.name.label')}
          />
          {err.name ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.name}</p> : null}
        </SettingsStackedField>

        <SettingsStackedField
          label={t('settings.providers.page.custom.field.baseURL.label')}
          info={t('settings.providers.page.custom.field.baseURL.info')}
        >
          <Input
            value={form.baseURL}
            onChange={(event) => setField('baseURL', event.target.value)}
            placeholder={t('settings.providers.page.custom.field.baseURL.placeholder')}
            className="h-8 rounded-md px-3 font-mono text-xs"
            aria-invalid={Boolean(err.baseURL)}
            aria-label={t('settings.providers.page.custom.field.baseURL.label')}
          />
          {err.baseURL ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.baseURL}</p> : null}
        </SettingsStackedField>

        <SettingsStackedField
          label={t('settings.providers.page.custom.field.apiKey.label')}
          info={
            isEdit && allowExistingAuth
              ? t('settings.providers.page.custom.field.apiKey.editInfo')
              : t('settings.providers.page.custom.field.apiKey.info')
          }
        >
          <Input
            type="password"
            value={form.apiKey}
            onChange={(event) => setField('apiKey', event.target.value)}
            placeholder={
              isEdit && allowExistingAuth
                ? t('settings.providers.page.custom.field.apiKey.editPlaceholder')
                : t('settings.providers.page.custom.field.apiKey.placeholder')
            }
            className="h-8 rounded-md px-3 font-mono text-xs"
            aria-invalid={Boolean(err.apiKey)}
            aria-label={t('settings.providers.page.custom.field.apiKey.label')}
          />
          {err.apiKey ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.apiKey}</p> : null}
        </SettingsStackedField>
      </SettingsSection>

      <SettingsSection
        title={t('settings.providers.page.custom.models.title')}
        headerAction={(
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => void handleFetchModels()}
            disabled={busy || discoveryBusy}
          >
            {discoveryBusy
              ? t('settings.providers.page.custom.models.discovery.fetching')
              : t('settings.providers.page.custom.models.discovery.fetch')}
          </Button>
        )}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        {form.models.map((model, index) => (
          <div key={model.row} className={`${SETTINGS_CONTROL_CLUSTER_CLASS} space-y-2`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {t('settings.providers.page.custom.models.idLabel')}
                  </label>
                  <Input
                    value={model.id}
                    onChange={(event) => setModel(index, 'id', event.target.value)}
                    placeholder={t('settings.providers.page.custom.models.idPlaceholder')}
                    className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                    aria-label={t('settings.providers.page.custom.models.idLabel')}
                  />
                  {modelErrors[index]?.id ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.id}</p>
                  ) : null}
                </div>
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {t('settings.providers.page.custom.models.nameLabel')}
                  </label>
                  <Input
                    value={model.name}
                    onChange={(event) => setModel(index, 'name', event.target.value)}
                    placeholder={t('settings.providers.page.custom.models.namePlaceholder')}
                    className="mt-1 h-8 rounded-md px-3"
                    aria-label={t('settings.providers.page.custom.models.nameLabel')}
                  />
                  {modelErrors[index]?.name ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.name}</p>
                  ) : null}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={SETTINGS_ICON_BUTTON_CLASS}
                disabled={form.models.length <= 1}
                onClick={() => {
                  if (form.models.length <= 1) return;
                  setForm((prev) => ({
                    ...prev,
                    models: prev.models.filter((_, rowIndex) => rowIndex !== index),
                  }));
                  setModelErrors((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
                }}
                aria-label={t('settings.providers.page.custom.models.remove')}
              >
                <Icon name="delete-bin" className="size-4" />
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => {
            setForm((prev) => ({ ...prev, models: [...prev.models, createModelRow()] }));
            setModelErrors((prev) => [...prev, {}]);
          }}
        >
          {t('settings.providers.page.custom.models.add')}
        </Button>

        {discoveryAttempted && !discoveryBusy && !discoveryError && discoveredModels.length === 0 ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.providers.page.custom.models.discovery.empty')}
          </p>
        ) : null}

        {discoveryError ? (
          <p className="typography-meta text-[var(--status-error)]" role="status">
            {discoveryError}
          </p>
        ) : null}

        {discoveredModels.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="typography-meta text-muted-foreground">
                {t('settings.providers.page.custom.models.discovery.selection', {
                  selected: String(discoverySelection.size),
                  total: String(discoveredModels.length),
                })}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="!font-normal"
                  onClick={() =>
                    setDiscoverySelection(new Set(discoveredModels.map((model) => model.id)))
                  }
                >
                  {t('settings.providers.page.custom.models.discovery.selectAll')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="!font-normal"
                  onClick={() => setDiscoverySelection(new Set())}
                >
                  {t('settings.providers.page.custom.models.discovery.clearSelection')}
                </Button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto border-t border-[var(--surface-subtle)]">
              {discoveredModels.map((model) => (
                <SettingsCheckboxRow
                  key={model.id}
                  checked={discoverySelection.has(model.id)}
                  onChange={(checked) => toggleDiscovered(model.id, checked)}
                  label={(
                    <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                      <span className="truncate typography-meta font-medium text-foreground">{model.name}</span>
                      <span className="shrink-0 font-mono typography-micro text-muted-foreground">{model.id}</span>
                    </span>
                  )}
                  ariaLabel={t('settings.providers.page.custom.models.discovery.selectModel', { name: model.name })}
                />
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              disabled={discoverySelection.size === 0}
              onClick={handleAddDiscovered}
            >
              {t('settings.providers.page.custom.models.discovery.addSelected', {
                count: String(discoverySelection.size),
              })}
            </Button>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t('settings.providers.page.custom.headers.title')}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.providers.page.custom.headers.description')}</p>
        {form.headers.map((header, index) => (
          <div key={header.row} className={`${SETTINGS_CONTROL_CLUSTER_CLASS} space-y-2`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {t('settings.providers.page.custom.headers.keyLabel')}
                  </label>
                  <Input
                    value={header.key}
                    onChange={(event) => setHeader(index, 'key', event.target.value)}
                    placeholder={t('settings.providers.page.custom.headers.keyPlaceholder')}
                    className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                    aria-label={t('settings.providers.page.custom.headers.keyLabel')}
                  />
                  {headerErrors[index]?.key ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{headerErrors[index]?.key}</p>
                  ) : null}
                </div>
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {t('settings.providers.page.custom.headers.valueLabel')}
                  </label>
                  <Input
                    value={header.value}
                    onChange={(event) => setHeader(index, 'value', event.target.value)}
                    placeholder={t('settings.providers.page.custom.headers.valuePlaceholder')}
                    className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                    aria-label={t('settings.providers.page.custom.headers.valueLabel')}
                  />
                  {headerErrors[index]?.value ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{headerErrors[index]?.value}</p>
                  ) : null}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={SETTINGS_ICON_BUTTON_CLASS}
                disabled={form.headers.length <= 1}
                onClick={() => {
                  if (form.headers.length <= 1) return;
                  setForm((prev) => ({
                    ...prev,
                    headers: prev.headers.filter((_, rowIndex) => rowIndex !== index),
                  }));
                  setHeaderErrors((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
                }}
                aria-label={t('settings.providers.page.custom.headers.remove')}
              >
                <Icon name="delete-bin" className="size-4" />
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => {
            setForm((prev) => ({ ...prev, headers: [...prev.headers, createHeaderRow()] }));
            setHeaderErrors((prev) => [...prev, {}]);
          }}
        >
          {t('settings.providers.page.custom.headers.add')}
        </Button>
      </SettingsSection>

      <div className="flex flex-wrap items-center gap-2 py-4">
        {onCancel ? (
          <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={onCancel} disabled={busy}>
            {t('settings.providers.page.custom.actions.back')}
          </Button>
        ) : null}
        {onDisconnect ? (
          <Button
            type="button"
            variant="destructive"
            size="xs"
            className="!font-normal"
            onClick={() => void onDisconnect()}
            disabled={busy}
          >
            {t('settings.providers.page.actions.disconnect')}
          </Button>
        ) : null}
        <Button type="submit" size="xs" className="!font-normal" disabled={busy}>
          {busy
            ? t('settings.providers.page.actions.saving')
            : isEdit
              ? t('settings.providers.page.custom.actions.update')
              : t('settings.providers.page.custom.actions.save')}
        </Button>
      </div>
    </form>
  );
};
