"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { saveAiSettingsAction, testProviderAction } from "@/lib/ai/actions";
import type { SettingsFormState, TestFormState } from "@/lib/ai/form-state";
import { MODEL_ROLE_HINTS, MODEL_ROLE_LABELS, PROVIDER_KIND_HINTS, PROVIDER_KIND_LABELS } from "@/lib/ai/labels";
import { defaultUrlFor, emptyRoles } from "@/lib/ai/schema";
import { CSRF_FIELD } from "@/lib/security/constants";
import { CAPTURE_ROLES, INSIGHT_ROLES, MODEL_ROLES, SEMANTIC_ROLES } from "@/lib/ai/types";
import type {
  PublicAiConfig,
  PublicProvider,
  ProviderKind,
  RoleAssignment,
  RoleMap,
  ModelRole,
} from "@/lib/ai/types";

interface DraftProvider extends PublicProvider {
  apiKey: string;
}

export function SettingsForm({
  initial,
  csrfToken,
}: {
  initial: PublicAiConfig;
  csrfToken: string;
}) {
  const [providers, setProviders] = useState<DraftProvider[]>(() =>
    initial.providers.map((provider) => ({ ...provider, apiKey: "" })),
  );
  const [roles, setRoles] = useState<RoleMap>(initial.roles);
  const [models, setModels] = useState<Record<string, string[]>>({});

  const [saveState, saveAction] = useActionState<SettingsFormState, FormData>(
    saveAiSettingsAction,
    {},
  );
  const [testState, testAction] = useActionState<TestFormState, FormData>(
    testProviderAction,
    {},
  );

  useEffect(() => {
    if (testState.ok && testState.providerId && testState.models) {
      setModels((current) => ({ ...current, [testState.providerId!]: testState.models! }));
    }
  }, [testState]);

  const payload = useMemo(
    () =>
      JSON.stringify({
        providers: providers.map(({ apiKey, hasApiKey, ...provider }) => ({
          ...provider,
          apiKey: apiKey.trim() || undefined,
        })),
        roles: Object.fromEntries(
          MODEL_ROLES.map((role) => {
            const assignment = roles[role];
            if (!assignment?.providerId || !assignment.model.trim()) return [role, null];
            return [role, { providerId: assignment.providerId, model: assignment.model.trim() }];
          }),
        ),
      }),
    [providers, roles],
  );

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h2 className="text-lg font-medium">Providers</h2>
        <p className="text-sm text-ink-400">
          Model calls go through the server, never the browser. Test a connection
          before assigning it to a role — the test does not send any dream.
        </p>
        {providers.map((provider, index) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            models={models[provider.id] ?? []}
            testState={testState.providerId === provider.id ? testState : {}}
            testAction={testAction}
            csrfToken={csrfToken}
            onChange={(patch) =>
              setProviders((current) =>
                current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
              )
            }
            onRemove={
              providers.length > 1
                ? () => {
                    setProviders((current) => current.filter((_, i) => i !== index));
                    setRoles((current) => stripProvider(current, provider.id));
                  }
                : undefined
            }
          />
        ))}
        <div className="flex flex-wrap gap-2">
          {(["openai", "anthropic", "ollama"] as ProviderKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              className="btn btn-ghost text-sm"
              onClick={() => setProviders((current) => [...current, newProvider(kind)])}
            >
              Add {PROVIDER_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      </div>

      <form action={saveAction} className="space-y-6">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="config" value={payload} />

        <div className="space-y-4">
          <h2 className="text-lg font-medium">Insight roles</h2>
          <p className="text-sm text-ink-400">
            Each insight kind is opt-in. Nothing is sent until a model is assigned
            here and you confirm the destination on the entry itself.
          </p>
          {INSIGHT_ROLES.map((role) => (
            <RoleRow
              key={role}
              role={role}
              assignment={roles[role]}
              providers={providers.filter((provider) => provider.enabled)}
              models={models}
              onChange={(assignment) =>
                setRoles((current) => ({ ...current, [role]: assignment }))
              }
            />
          ))}
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-medium">Capture roles</h2>
          <p className="text-sm text-ink-400">
            Page reading needs a vision-capable model. Splitting a log that
            contains several dreams is text-only.
          </p>
          {CAPTURE_ROLES.map((role) => (
            <RoleRow
              key={role}
              role={role}
              assignment={roles[role]}
              providers={providers.filter((provider) => provider.enabled)}
              models={models}
              onChange={(assignment) =>
                setRoles((current) => ({ ...current, [role]: assignment }))
              }
            />
          ))}
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-medium">Semantic roles</h2>
          <p className="text-sm text-ink-400">
            The embedding model turns entries into vectors so search can work by
            meaning; it must be an embedding model, not a chat one. Keep it local
            and entries are indexed as you write them — a remote one is only used
            when you ask for it on the search page, so writing an entry never
            sends it anywhere on its own.
          </p>
          {SEMANTIC_ROLES.map((role) => (
            <RoleRow
              key={role}
              role={role}
              assignment={roles[role]}
              providers={providers.filter((provider) => provider.enabled)}
              models={models}
              onChange={(assignment) =>
                setRoles((current) => ({ ...current, [role]: assignment }))
              }
            />
          ))}
        </div>

        <FormError message={saveState.error} />
        {saveState.saved && (
          <p role="status" className="text-sm text-ok-500">
            Saved.
          </p>
        )}
        <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
      </form>
    </div>
  );
}

function ProviderCard({
  provider,
  models,
  testState,
  testAction,
  csrfToken,
  onChange,
  onRemove,
}: {
  provider: DraftProvider;
  models: string[];
  testState: TestFormState;
  testAction: (payload: FormData) => void;
  csrfToken: string;
  onChange: (patch: Partial<DraftProvider>) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="card space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{provider.name || PROVIDER_KIND_LABELS[provider.kind]}</h3>
          <p className="text-xs text-ink-400">{PROVIDER_KIND_HINTS[provider.kind]}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
            className="size-4 accent-lucid-500"
          />
          Enabled
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`name-${provider.id}`}>
            Name
          </label>
          <input
            id={`name-${provider.id}`}
            className="field"
            value={provider.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor={`url-${provider.id}`}>
            Base URL
          </label>
          <input
            id={`url-${provider.id}`}
            className="field font-mono text-sm"
            value={provider.baseUrl}
            onChange={(event) => onChange({ baseUrl: event.target.value })}
            placeholder={defaultUrlFor(provider.kind)}
          />
        </div>
      </div>

      {provider.kind !== "ollama" && (
        <div>
          <label className="label" htmlFor={`key-${provider.id}`}>
            API key
          </label>
          <input
            id={`key-${provider.id}`}
            type="password"
            autoComplete="off"
            className="field font-mono text-sm"
            value={provider.apiKey}
            placeholder={provider.hasApiKey ? "Saved — type to replace" : "Not set"}
            onChange={(event) => onChange({ apiKey: event.target.value })}
          />
        </div>
      )}

      <form action={testAction} className="flex flex-wrap items-center gap-3">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="providerId" value={provider.id} />
        <input type="hidden" name="kind" value={provider.kind} />
        <input type="hidden" name="name" value={provider.name} />
        <input type="hidden" name="baseUrl" value={provider.baseUrl} />
        <input type="hidden" name="apiKey" value={provider.apiKey} />
        <SubmitButton className="btn btn-ghost" pendingLabel="Testing…">
          Test connection
        </SubmitButton>
        {testState.message && (
          <p className={`text-sm ${testState.ok ? "text-ok-500" : "text-danger-500"}`}>
            {testState.message}
          </p>
        )}
      </form>

      {models.length > 0 && (
        <p className="text-xs text-ink-400">
          Models: {models.slice(0, 12).join(", ")}
          {models.length > 12 ? ` +${models.length - 12}` : ""}
        </p>
      )}

      {onRemove && (
        <button type="button" className="text-sm text-danger-500 hover:underline" onClick={onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}

function RoleRow({
  role,
  assignment,
  providers,
  models,
  onChange,
}: {
  role: ModelRole;
  assignment: RoleAssignment | null;
  providers: DraftProvider[];
  models: Record<string, string[]>;
  onChange: (assignment: RoleAssignment | null) => void;
}) {
  const providerId = assignment?.providerId ?? "";
  const listed = models[providerId] ?? [];

  return (
    <div className="grid gap-3 rounded-lg border border-ink-800 p-4 sm:grid-cols-[1fr_1fr_1fr] sm:items-end">
      <div>
        <p className="text-sm font-medium text-ink-200">{MODEL_ROLE_LABELS[role]}</p>
        <p className="mt-1 text-xs text-ink-400">{MODEL_ROLE_HINTS[role]}</p>
      </div>
      <div>
        <label className="label" htmlFor={`provider-${role}`}>
          Provider
        </label>
        <select
          id={`provider-${role}`}
          className="field"
          value={providerId}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next ? { providerId: next, model: assignment?.model ?? "" } : null);
          }}
        >
          <option value="">Not assigned</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={`model-${role}`}>
          Model
        </label>
        <input
          id={`model-${role}`}
          className="field font-mono text-sm"
          list={`models-${role}`}
          value={assignment?.model ?? ""}
          disabled={!providerId}
          onChange={(event) => {
            if (!providerId) return;
            onChange({ providerId, model: event.target.value });
          }}
          placeholder="llama3.2"
        />
        <datalist id={`models-${role}`}>
          {listed.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

function CsrfInput({ token }: { token: string }) {
  return <input type="hidden" name={CSRF_FIELD} value={token} />;
}

function newProvider(kind: ProviderKind): DraftProvider {
  const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    kind,
    name: PROVIDER_KIND_LABELS[kind],
    baseUrl: defaultUrlFor(kind),
    enabled: true,
    hasApiKey: false,
    apiKey: "",
  };
}

function stripProvider(roles: RoleMap, providerId: string): RoleMap {
  const next = { ...emptyRoles(), ...roles };
  for (const role of MODEL_ROLES) {
    if (next[role]?.providerId === providerId) next[role] = null;
  }
  return next;
}
