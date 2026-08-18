"use client";

import { useState } from "react";

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Save your recovery codes</h2>
        <p className="mt-2 text-sm text-ink-400">
          These are the only way back in if you lose your authenticator. Each
          works once. They are shown now and never again — not even by us, since
          only their fingerprints are stored.
        </p>
      </div>

      <ul className="grid grid-cols-2 gap-2 rounded-lg border border-ink-700 bg-ink-950 p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="text-ink-200">
            {code}
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-ghost flex-1"
          onClick={() => {
            void navigator.clipboard.writeText(codes.join("\n"));
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy to clipboard"}
        </button>
        <button
          type="button"
          className="btn btn-ghost flex-1"
          onClick={() => window.print()}
        >
          Print
        </button>
      </div>

      <label className="flex items-start gap-2 text-sm text-ink-300">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-1"
        />
        I have saved these somewhere safe and offline.
      </label>

      <a
        href="/"
        aria-disabled={!confirmed}
        className={`btn btn-primary w-full ${confirmed ? "" : "pointer-events-none opacity-50"}`}
      >
        Continue to my journal
      </a>
    </div>
  );
}
