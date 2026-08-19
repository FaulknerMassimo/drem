import Link from "next/link";
import { redirect } from "next/navigation";
import { CsrfField } from "@/components/csrf-field";
import { logoutAction } from "@/lib/auth/actions";
import { currentSession, needsSetup } from "@/lib/auth/session";
import { countDrafts } from "@/lib/journal/dreams";
import { countInbox } from "@/lib/capture/attachments";
import { nightDateFor } from "@/lib/journal/dates";
import { kickWorker } from "@/lib/ai/worker";

export const dynamic = "force-dynamic";

/**
 * The gate for everything behind a login.
 *
 * The check is here rather than in middleware because middleware cannot see the
 * database or the in-process key store, and a cookie's presence alone proves
 * nothing. `currentSession()` returns null whenever the keys are gone — which
 * includes the ordinary case of a server restart.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await needsSetup()) redirect("/setup");
  const session = await currentSession();
  if (!session) redirect("/login");

  const [drafts, inbox] = await Promise.all([
    countDrafts(session.userId),
    countInbox(session.userId),
  ]);
  const tonight = nightDateFor();
  // Drain any jobs that were waiting on this session's keys.
  kickWorker();

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-baseline gap-5">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              drem
            </Link>
            <nav className="flex items-center gap-4 text-sm text-ink-400">
              <Link href="/journal" className="hover:text-ink-200">
                Journal
              </Link>
              <Link href="/search" className="hover:text-ink-200">
                Search
              </Link>
              <Link href="/drafts" className="hover:text-ink-200">
                Drafts
                {drafts > 0 && (
                  <span className="ml-1.5 rounded-full bg-warn-500/20 px-1.5 py-0.5 text-xs text-warn-500">
                    {drafts}
                  </span>
                )}
              </Link>
              <Link href={`/night/${tonight}`} className="hover:text-ink-200">
                Tonight
              </Link>
              <Link href="/import" className="hover:text-ink-200">
                Import
                {inbox > 0 && (
                  <span className="ml-1.5 rounded-full bg-warn-500/20 px-1.5 py-0.5 text-xs text-warn-500">
                    {inbox}
                  </span>
                )}
              </Link>
              <Link href="/signs" className="hover:text-ink-200">
                Signs
              </Link>
              <Link href="/reports" className="hover:text-ink-200">
                Reports
              </Link>
              <Link href="/settings" className="hover:text-ink-200">
                Settings
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-4">
            {/* Reachable from every screen: the moment it is needed there is no
                time to go looking for it. */}
            <Link href="/capture" className="text-sm text-lucid-300 hover:text-lucid-400">
              Capture
            </Link>
            <form action={logoutAction}>
              <CsrfField />
              <button type="submit" className="text-sm text-ink-400 hover:text-ink-200">
                Lock
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
