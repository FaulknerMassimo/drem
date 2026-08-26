"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { ChevronIcon, SpinnerIcon } from "@/components/chat-icons";
import { CSRF_FIELD } from "@/lib/security/constants";
import {
  listProviderModelsAction,
  type ProviderModelsState,
} from "@/lib/ai/conversation-actions";
import type { ChatModelOption } from "@/lib/ai/types";

export interface ModelChoice {
  providerId: string;
  model: string;
}

/**
 * Chooses the model for the conversation, from the conversation.
 *
 * It used to live in Settings, four screens away, which made "try that again
 * on the bigger model" a round trip through a page full of unrelated
 * assignments. The choice is the same one Settings makes — this writes the
 * `chat` role — so there is still only one answer to which model chat uses.
 *
 * Where a choice would send the message is on the button and beside every
 * option, because this is the control that can turn a local conversation into
 * a remote one. A remote provider is never asked for its model list on its
 * own: that is a request to somebody else's server, so it takes a button.
 */
export function ChatModelPicker({
  options,
  selected,
  onSelect,
  csrfToken,
  disabled = false,
}: {
  options: ChatModelOption[];
  selected: ModelChoice | null;
  onSelect: (choice: ModelChoice) => void;
  csrfToken: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [listed, setListed] = useState<Record<string, string[]>>({});
  const [typedProvider, setTypedProvider] = useState(
    selected?.providerId ?? options[0]?.providerId ?? "",
  );
  const [typed, setTyped] = useState("");
  const panel = useRef<HTMLDivElement>(null);

  const [state, listModels, listing] = useActionState<ProviderModelsState, FormData>(
    listProviderModelsAction,
    {},
  );

  useEffect(() => {
    if (state.providerId && state.models) {
      setListed((current) => ({ ...current, [state.providerId!]: state.models! }));
    }
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const current = options.find((option) => option.providerId === selected?.providerId) ?? null;
  const choose = (providerId: string, model: string) => {
    onSelect({ providerId, model: model.trim() });
    setOpen(false);
  };

  return (
    <div className="relative min-w-0" ref={panel}>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full max-w-[9rem] items-center gap-2 rounded-lg border border-ink-800 bg-ink-900 px-3 py-1.5 text-sm text-ink-200 transition-colors hover:border-ink-700 hover:text-ink-100 disabled:opacity-50 sm:max-w-[18rem]"
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            !current ? "bg-ink-600" : current.leavesMachine ? "bg-warn-500" : "bg-ok-500"
          }`}
          aria-hidden
        />
        <span className="truncate font-mono text-xs">
          {selected?.model ?? "Choose a model"}
        </span>
        <ChevronIcon className="size-3.5 shrink-0 text-ink-500" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-ink-800 bg-ink-900 p-2 shadow-2xl shadow-black/60"
        >
          {options.length === 0 && (
            <p className="px-2 py-3 text-sm text-ink-400">
              No providers are enabled. Add one in{" "}
              <a href="/settings" className="text-lucid-300 hover:text-lucid-400">
                Settings
              </a>
              .
            </p>
          )}

          {options.map((option) => {
            const models = [
              ...new Set([...option.models, ...(listed[option.providerId] ?? [])]),
            ].sort((a, b) => a.localeCompare(b));
            return (
              <div key={option.providerId} className="mb-1 last:mb-0">
                <div className="flex items-baseline justify-between gap-2 px-2 pb-1 pt-2">
                  <span className="truncate text-xs font-medium text-ink-300">
                    {option.providerName}
                  </span>
                  <span
                    className={`shrink-0 text-[0.6875rem] ${
                      option.leavesMachine ? "text-warn-500" : "text-ok-500"
                    }`}
                  >
                    {option.leavesMachine ? `leaves for ${option.host}` : "this machine"}
                  </span>
                </div>

                {models.map((model) => {
                  const active =
                    selected?.providerId === option.providerId && selected.model === model;
                  return (
                    <button
                      key={model}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => choose(option.providerId, model)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-mono text-xs transition-colors ${
                        active
                          ? "bg-lucid-500/15 text-ink-100"
                          : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
                      }`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          active ? "bg-lucid-400" : "bg-transparent"
                        }`}
                        aria-hidden
                      />
                      <span className="truncate">{model}</span>
                    </button>
                  );
                })}

                <form action={listModels} className="px-2 pt-1">
                  <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
                  <input type="hidden" name="providerId" value={option.providerId} />
                  <button
                    type="submit"
                    disabled={listing}
                    className="flex items-center gap-1.5 text-[0.6875rem] text-ink-500 hover:text-ink-300 disabled:opacity-50"
                  >
                    {listing && <SpinnerIcon className="size-3" />}
                    {models.length === 0 ? "Ask what models it has" : "Refresh the list"}
                  </button>
                </form>
                {state.error && state.providerId === option.providerId && (
                  <p className="px-2 pt-1 text-[0.6875rem] text-danger-500">{state.error}</p>
                )}
              </div>
            );
          })}

          {options.length > 0 && (
            <div className="mt-2 border-t border-ink-800 pt-2">
              <label className="px-2 text-[0.6875rem] text-ink-500" htmlFor="chat-model-typed">
                Or type a model name
              </label>
              <div className="mt-1 flex items-center gap-1.5 px-2 pb-1">
                {options.length > 1 && (
                  <select
                    aria-label="Provider"
                    value={typedProvider}
                    onChange={(event) => setTypedProvider(event.target.value)}
                    className="field w-28 px-2 py-1 text-xs"
                  >
                    {options.map((option) => (
                      <option key={option.providerId} value={option.providerId}>
                        {option.providerName}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  id="chat-model-typed"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder="qwen3:8b"
                  className="field min-w-0 flex-1 px-2 py-1 font-mono text-xs"
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (typed.trim()) choose(typedProvider, typed);
                  }}
                />
                <button
                  type="button"
                  disabled={!typed.trim()}
                  onClick={() => choose(typedProvider, typed)}
                  className="btn btn-ghost px-2 py-1 text-xs"
                >
                  Use
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
