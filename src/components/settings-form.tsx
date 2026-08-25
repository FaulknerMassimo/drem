"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { saveAiSettingsAction, testProviderAction } from "@/lib/ai/actions";
import type { SettingsFormState, TestFormState } from "@/lib/ai/form-state";
import { MODEL_ROLE_HINTS, MODEL_ROLE_LABELS, PROVIDER_KIND_HINTS, PROVIDER_KIND_LABELS } from "@/lib/ai/labels";
import { defaultUrlFor, emptyRoles } from "@/lib/ai/schema";
import { randomUuid } from "@/lib/random-id";
import { CSRF_FIELD } from "@/lib/security/constants";
import {
  CAPTURE_ROLES,
  CONVERSATION_ROLES,
  INSIGHT_ROLES,
  MODEL_ROLES,
  SEMANTIC_ROLES,
} from "@/lib/ai/types";
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
  initialModels,
  csrfToken,
}: {
  initial: PublicAiConfig;
  /** Models already known for providers on this machine, by provider id. */
  initialModels: Record<string, string[]>;
  csrfToken: string;
}) {
  const [providers, setProviders] = useState<DraftProvider[]>(() =>
    initial.providers.map((provider) => ({ ...provider, apiKey: "" })),
  );
  const [roles, setRoles] = useState<RoleMap>(initial.roles);
  const [models, setModels] = useState<Record<string, string[]>>(initialModels);

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

        <BulkAssign
          providers={providers.filter((provider) => provider.enabled)}
          models={models}
          onAssign={(providerId, model) =>
            setRoles((current) => assignEveryTextRole(current, providerId, model))
          }
        />

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
            Page reading needs a vision-capable model; a photographed night is
            copied one page at a time. Splitting the joined log into dreams is
            text-only, and runs after a reading if a split model is assigned.
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
            The embedding role needs an embedding model, not a chat one. Keep it
            local and entries are indexed as you write them.
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

        <div className="space-y-4">
          <h2 className="text-lg font-medium">Conversation role</h2>
          <p className="text-sm text-ink-400">
            Journal chat uses a tool-capable text model. It starts with the
            conversation only, then reads selected journal data through
            validated, read-only tools when the question calls for it.
          </p>
          {CONVERSATION_ROLES.map((role) => (
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
      <ModelField
        role={role}
        model={assignment?.model ?? ""}
        listed={listed}
        disabled={!providerId}
        onChange={(model) => {
          if (!providerId) return;
          onChange({ providerId, model });
        }}
      />
    </div>
  );
}

/**
 * Pick a model, rather than remember one.
 *
 * This was a text box with a `datalist` behind it — which offers nothing a
 * browser draws until you have already started typing the right answer, and
 * was empty anyway until somebody thought to press Test connection. Where the
 * provider's models are known they are a real list; typing stays available
 * through "Other", because a provider that cannot be listed (any remote one,
 * until it is tested) still has to be assignable.
 */
function ModelField({
  role,
  model,
  listed,
  disabled,
  onChange,
}: {
  role: ModelRole;
  model: string;
  listed: string[];
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const known = listed.length > 0;
  const [freeText, setFreeText] = useState(() => known && model !== "" && !listed.includes(model));

  const showList = known && !freeText;

  return (
    <div>
      <label className="label" htmlFor={`model-${role}`}>
        Model
      </label>
      {showList ? (
        <select
          id={`model-${role}`}
          className="field font-mono text-sm"
          value={listed.includes(model) ? model : ""}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === OTHER_MODEL) {
              setFreeText(true);
              onChange("");
              return;
            }
            onChange(event.target.value);
          }}
        >
          <option value="">Not assigned</option>
          {listed.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={OTHER_MODEL}>Other…</option>
        </select>
      ) : (
        <input
          id={`model-${role}`}
          className="field font-mono text-sm"
          value={model}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={MODEL_ROLE_PLACEHOLDERS[role]}
        />
      )}
      {known && freeText && (
        <button
          type="button"
          className="mt-1 text-xs text-ink-400 hover:text-ink-200"
          onClick={() => {
            setFreeText(false);
            onChange("");
          }}
        >
          Choose from installed models
        </button>
      )}
    </div>
  );
}

const OTHER_MODEL = "__other__";

/**
 * A placeholder per role, because they are not interchangeable.
 *
 * Every one of these boxes used to suggest `llama3.2` — including the
 * embedding role, where a chat model produces an index that silently answers
 * nothing, and the page-reading role, where a text-only model answers a
 * photograph with an HTTP 400 a quarter of an hour later.
 */
const MODEL_ROLE_PLACEHOLDERS: Record<ModelRole, string> = {
  extraction: "llama3.2",
  lucidity: "llama3.2",
  symbolic: "llama3.2",
  report: "llama3.2",
  ocr: "qwen2.5vl",
  split: "llama3.2",
  embedding: "embeddinggemma",
  signs: "llama3.2",
  chat: "llama3.2",
};

/**
 * Fills every text role at once.
 *
 * Assigning a model to nine roles by hand is what stood between a fresh
 * install and anything working at all, and eight of the nine want the same
 * general-purpose model anyway. Embedding and page reading are left out on
 * purpose: they need a different kind of model, and quietly pointing them at a
 * chat one produces an index that returns nothing and a page reading that
 * fails with a 400.
 */
const BULK_ROLES: ModelRole[] = [
  "extraction",
  "lucidity",
  "symbolic",
  "report",
  "split",
  "signs",
  "chat",
];

function assignEveryTextRole(roles: RoleMap, providerId: string, model: string): RoleMap {
  const next = { ...emptyRoles(), ...roles };
  for (const role of BULK_ROLES) next[role] = { providerId, model };
  return next;
}

function BulkAssign({
  providers,
  models,
  onAssign,
}: {
  providers: DraftProvider[];
  models: Record<string, string[]>;
  onAssign: (providerId: string, model: string) => void;
}) {
  const withModels = providers.filter((provider) => (models[provider.id] ?? []).length > 0);
  const [providerId, setProviderId] = useState(withModels[0]?.id ?? "");
  const listed = models[providerId] ?? [];
  const [model, setModel] = useState("");

  if (withModels.length === 0) return null;

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-ink-800 bg-ink-900 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink-200">Set the text roles at once</p>
        <p className="mt-1 text-xs text-ink-400">
          Fills extraction, lucidity, symbolic, reports, splitting and the sign
          scan. Page reading and embedding are left alone — they need a vision
          and an embedding model.
        </p>
      </div>
      {withModels.length > 1 && (
        <select
          aria-label="Provider"
          className="field w-auto"
          value={providerId}
          onChange={(event) => {
            setProviderId(event.target.value);
            setModel("");
          }}
        >
          {withModels.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
      )}
      <select
        aria-label="Model for every text role"
        className="field w-auto font-mono text-sm"
        value={model}
        onChange={(event) => setModel(event.target.value)}
      >
        <option value="">Choose a model…</option>
        {listed.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-ghost text-sm"
        disabled={!model || !providerId}
        onClick={() => onAssign(providerId, model)}
      >
        Apply
      </button>
    </div>
  );
}

function CsrfInput({ token }: { token: string }) {
  return <input type="hidden" name={CSRF_FIELD} value={token} />;
}

function newProvider(kind: ProviderKind): DraftProvider {
  const id = `${kind}-${randomUuid().slice(0, 8)}`;
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
