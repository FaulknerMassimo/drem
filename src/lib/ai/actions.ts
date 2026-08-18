"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { recordAuthEvent, clientContext } from "@/lib/auth/audit";
import { currentSession, type ActiveSession } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { isIsoDate } from "@/lib/journal/dates";
import { assertCsrf } from "@/lib/security/csrf-server";
import { loadAiConfig, saveAiConfig } from "./config";
import { destinationFor } from "./destination";
import type { InsightFormState, SettingsFormState, TestFormState } from "./form-state";
import { enqueueDreamInsight, enqueuePeriodReport } from "./jobs";
import { providerTest } from "./providers";
import { defaultUrlFor, isInsightRole, parseAiConfig } from "./schema";
import type { DreamInsightKind, InsightRole, ProviderConfig, ProviderKind } from "./types";
import { PROVIDER_KINDS } from "./types";
import { kickWorker } from "./worker";

async function requireUnlockedSession(): Promise<ActiveSession> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

async function requestContext() {
  return clientContext(await headers(), {
    trustProxy: env().APP_ORIGIN.startsWith("https://"),
  });
}

function refreshAi(): void {
  revalidatePath("/", "layout");
}

export async function saveAiSettingsAction(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const raw = String(formData.get("config") ?? "");
  let incoming;
  try {
    incoming = parseAiConfig(JSON.parse(raw));
  } catch {
    return { error: "That configuration could not be read." };
  }

  await saveAiConfig(session.userId, session.keys, incoming);
  await recordAuthEvent("settings_changed", {
    userId: session.userId,
    detail: { section: "ai" },
    request: await requestContext(),
  });
  refreshAi();
  return { saved: true };
}

export async function testProviderAction(
  _previous: TestFormState,
  formData: FormData,
): Promise<TestFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const providerId = String(formData.get("providerId") ?? "");
  const kind = String(formData.get("kind") ?? "");
  if (!isProviderKind(kind) || !providerId) {
    return { error: "That provider is not recognised." };
  }

  const stored = await loadAiConfig(session.userId, session.keys);
  const previous = stored.providers.find((provider) => provider.id === providerId);
  const typedKey = String(formData.get("apiKey") ?? "").trim();

  const provider: ProviderConfig = {
    id: providerId,
    kind,
    name: String(formData.get("name") ?? kind),
    baseUrl: String(formData.get("baseUrl") ?? "").trim() || defaultUrlFor(kind),
    apiKey: typedKey || previous?.apiKey,
    enabled: true,
  };

  const result = await providerTest(provider);
  return {
    ok: result.ok,
    message: result.message,
    models: result.models,
    providerId,
    error: result.ok ? undefined : result.message,
  };
}

export async function requestInsightAction(
  _previous: InsightFormState,
  formData: FormData,
): Promise<InsightFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const dreamId = String(formData.get("dreamId") ?? "");
  const kind = String(formData.get("kind") ?? "");
  if (!dreamId || !isDreamKind(kind)) {
    return { error: "That insight kind is not recognised." };
  }

  const gated = await gateDestination(session, kind, formData);
  if (gated) return gated;

  await enqueueDreamInsight(session.userId, dreamId, kind);
  kickWorker();
  refreshAi();
  return { queued: true };
}

export async function requestReportAction(
  _previous: InsightFormState,
  formData: FormData,
): Promise<InsightFormState> {
  await assertCsrf(formData);
  const session = await requireUnlockedSession();

  const periodStart = String(formData.get("periodStart") ?? "");
  const periodEnd = String(formData.get("periodEnd") ?? "");
  if (!isIsoDate(periodStart) || !isIsoDate(periodEnd)) {
    return { error: "Choose a start and end date." };
  }
  if (periodStart > periodEnd) {
    return { error: "The start of the period must be on or before the end." };
  }

  const gated = await gateDestination(session, "report", formData);
  if (gated) return gated;

  await enqueuePeriodReport(session.userId, periodStart, periodEnd);
  kickWorker();
  refreshAi();
  return { queued: true };
}

/**
 * The destination badge is not decorative: a remote call requires an explicit
 * acknowledgement, checked here rather than only in the browser, so a crafted
 * POST cannot skip it.
 */
async function gateDestination(
  session: ActiveSession,
  role: InsightRole,
  formData: FormData,
): Promise<InsightFormState | null> {
  const config = await loadAiConfig(session.userId, session.keys);
  const destination = destinationFor(config, role);
  if (!destination.configured) {
    return { error: "No model is assigned for this. Choose one in Settings." };
  }
  if (destination.leavesMachine && formData.get("acknowledge") !== "1") {
    return {
      error: `Confirm that you want this dream to be sent to ${destination.host}.`,
    };
  }
  return null;
}

function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

function isDreamKind(value: string): value is DreamInsightKind {
  return isInsightRole(value) && value !== "report";
}
