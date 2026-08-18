import { redirect } from "next/navigation";
import { CsrfField } from "@/components/csrf-field";
import { currentSession, needsSetup } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await needsSetup()) redirect("/setup");
  if (await currentSession()) redirect("/");

  return (
    <LoginForm>
      <CsrfField />
    </LoginForm>
  );
}
