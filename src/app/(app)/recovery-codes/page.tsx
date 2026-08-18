import { redirect } from "next/navigation";
import { claimOnce } from "@/lib/auth/one-shot";
import { requireSession } from "@/lib/auth/session";
import { RecoveryCodes } from "./recovery-codes";

export const dynamic = "force-dynamic";

/**
 * Displays the recovery codes exactly once.
 *
 * Claiming is destructive, so a refresh shows nothing — which is the correct
 * behaviour: the codes are unrecoverable by design, and pretending otherwise
 * would encourage treating this page as somewhere to come back to.
 */
export default async function RecoveryCodesPage() {
  const session = await requireSession();
  const codes = claimOnce(session.sessionId);
  if (!codes) redirect("/");

  return <RecoveryCodes codes={codes} />;
}
