import type { AttachmentRecord } from "@/lib/capture/attachments";

export function AttachmentGallery({ attachments }: { attachments: AttachmentRecord[] }) {
  if (attachments.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Attachments</h2>
      <ul className="grid gap-4 sm:grid-cols-2">
        {attachments.map((attachment) => (
          <li key={attachment.id} className="card overflow-hidden p-0">
            {attachment.kind === "audio" ? (
              <div className="p-4">
                <audio controls src={`/api/attachments/${attachment.id}`} className="w-full" />
              </div>
            ) : (
              <a href={`/api/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/attachments/${attachment.id}`}
                  alt="Attached journal page"
                  className="max-h-80 w-full object-contain bg-ink-950"
                />
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
