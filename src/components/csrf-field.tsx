import { CSRF_FIELD } from "@/lib/security/constants";
import { readCsrfToken } from "@/lib/security/csrf-server";

/**
 * Renders the double-submit token into a form.
 *
 * Read on the server and emitted directly, rather than read from document.cookie
 * on the client, so the form works with JavaScript disabled.
 */
export async function CsrfField() {
  return <input type="hidden" name={CSRF_FIELD} value={await readCsrfToken()} />;
}
