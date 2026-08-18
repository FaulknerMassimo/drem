import { redirect } from "next/navigation";
import { CsrfField } from "@/components/csrf-field";
import { logoutAction } from "@/lib/auth/actions";
import { currentSession, needsSetup } from "@/lib/auth/session";

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
  if (!(await currentSession())) redirect("/login");

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <a href="/" className="text-lg font-semibold tracking-tight">
            drem
          </a>
          <form action={logoutAction}>
            <CsrfField />
            <button type="submit" className="text-sm text-ink-400 hover:text-ink-200">
              Lock
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
