import { CsrfField } from "@/components/csrf-field";
import { VerifyForm } from "./verify-form";

export const dynamic = "force-dynamic";

export default function VerifyPage() {
  return (
    <VerifyForm>
      <CsrfField />
    </VerifyForm>
  );
}
