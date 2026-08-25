import { ExportForm, RestoreForm } from "@/components/backup-forms";
import { EXPORT_ERRORS, isExportErrorCode } from "@/lib/backup/form-state";
import { sessionOrRedirect } from "@/lib/auth/session";
import { MIN_PASSPHRASE_LENGTH } from "@/lib/crypto/archive";
import { journalTotals } from "@/lib/journal/stats";
import { Why } from "@/components/why";
import { readCsrfToken } from "@/lib/security/csrf-server";

export const dynamic = "force-dynamic";

export default async function BackupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await sessionOrRedirect();
  const [{ error }, totals, csrfToken] = await Promise.all([
    searchParams,
    journalTotals(session.userId),
    readCsrfToken(),
  ]);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Backup</h1>
        <p className="max-w-2xl text-sm text-ink-400">
          {totals.dreams.toLocaleString("en-GB")} dreams across{" "}
          {totals.nights.toLocaleString("en-GB")} nights, in one file readable
          by nothing but its passphrase.
        </p>
      </div>

      {isExportErrorCode(error) && (
        <p
          role="alert"
          className="rounded-xl border border-danger-500/40 bg-danger-500/10 px-4 py-3 text-sm"
        >
          {EXPORT_ERRORS[error]}
        </p>
      )}

      <ExportForm csrfToken={csrfToken} minPassphraseLength={MIN_PASSPHRASE_LENGTH} />
      <RestoreForm csrfToken={csrfToken} />

      <Why label="What an archive holds, and what it leaves out">
        <p>
          Nights, dreams, tags and their ratings — everything a person wrote.
          Insights, embeddings and dream signs are left out on purpose: all
          three are derived from the entries and are rebuilt by re-running the
          models, and carrying them would double the file with data that goes
          stale the moment a prompt or an embedding model changes.
        </p>
        <p>
          Photographs and voice memos are not in it either. They are files
          rather than rows, they are far larger than the text, and they are
          already backed up by copying <code className="text-ink-300">UPLOAD_DIR</code>{" "}
          — which stores them encrypted, so a copy of that directory is as safe
          as the directory is.
        </p>
        <p>
          A full disaster plan needs three things kept apart:{" "}
          <code className="text-ink-300">MASTER_KEY</code>, the database, and
          this archive. <code className="text-ink-300">docs/BACKUP.md</code> has
          the procedure.
        </p>
      </Why>
    </div>
  );
}
