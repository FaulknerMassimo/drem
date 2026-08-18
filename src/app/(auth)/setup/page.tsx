import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/auth/session";
import { CsrfField } from "@/components/csrf-field";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/accounts";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // Setup is a one-time route. Once an account exists it must disappear, or a
  // self-hosted instance reachable from the network has an open door.
  if (!(await needsSetup())) redirect("/login");

  return (
    <SetupForm minPasswordLength={MIN_PASSWORD_LENGTH}>
      <CsrfField />
    </SetupForm>
  );
}
