import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav, type NavGroup } from "@/components/app-nav";
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

  const groups: NavGroup[] = [
    {
      label: "Write",
      items: [
        { href: `/night/${tonight}`, label: "Tonight", match: ["/night"] },
        { href: "/drafts", label: "Drafts", badge: drafts },
        { href: "/import", label: "Import", badge: inbox },
      ],
    },
    {
      label: "Journal",
      items: [
        { href: "/journal", label: "All entries", match: ["/dream"] },
        { href: "/search", label: "Search" },
      ],
    },
    {
      label: "Patterns",
      items: [
        { href: "/signs", label: "Dream signs" },
        { href: "/stats", label: "Statistics" },
        { href: "/reports", label: "Reports" },
      ],
    },
    {
      label: "System",
      items: [
        { href: "/backup", label: "Backup" },
        { href: "/settings", label: "Settings", match: ["/recovery-codes"] },
      ],
    },
  ];

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col md:flex-row">
      <header className="shrink-0 border-b border-ink-800 px-4 py-4 md:sticky md:top-0 md:h-dvh md:w-56 md:overflow-y-auto md:border-b-0 md:border-r md:py-6">
        <div className="flex items-center justify-between gap-3 md:block">
          <Link href="/" className="text-lg font-semibold tracking-tight md:px-3">
            drem
          </Link>

          {/* Reachable from every screen: the moment it is needed there is no
              time to go looking for it. */}
          <div className="flex items-center gap-3 md:mt-4 md:flex-col md:items-stretch md:gap-2">
            <Link href="/dream/new" className="btn btn-primary text-sm md:w-full">
              New entry
            </Link>
            <Link
              href="/capture"
              className="btn btn-ghost text-sm text-lucid-300 md:w-full"
            >
              Capture
            </Link>
          </div>
        </div>

        <div className="mt-4 md:mt-8">
          <AppNav groups={groups} />
        </div>

        <form action={logoutAction} className="mt-6 hidden md:block">
          <CsrfField />
          <button
            type="submit"
            className="w-full rounded-lg px-3 py-1.5 text-left text-sm text-ink-400 hover:bg-ink-900 hover:text-ink-200"
          >
            Lock
          </button>
        </form>
      </header>

      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-4xl px-4 py-8 md:px-8">{children}</main>

        <form action={logoutAction} className="px-4 pb-8 md:hidden">
          <CsrfField />
          <button type="submit" className="text-sm text-ink-400 hover:text-ink-200">
            Lock
          </button>
        </form>
      </div>
    </div>
  );
}
