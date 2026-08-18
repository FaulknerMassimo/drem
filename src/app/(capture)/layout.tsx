import { redirect } from "next/navigation";
import { currentSession, needsSetup } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Capture mode gets its own layout because it has to escape the app chrome
 * entirely: a header, a nav bar and a normal palette all defeat the point of a
 * screen designed to be usable at 4am without waking up.
 *
 * The session gate is repeated here rather than shared, because this route is
 * outside the `(app)` group and inheriting nothing is exactly the intent.
 */
export default async function CaptureLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await needsSetup()) redirect("/setup");
  if (!(await currentSession())) redirect("/login");

  return <div className="night-screen min-h-dvh">{children}</div>;
}
