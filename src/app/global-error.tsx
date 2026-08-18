"use client";

/**
 * Last-resort error boundary.
 *
 * Deliberately says nothing about what went wrong. An unhandled error in this
 * app may well have a decrypted dream in its stack, and rendering that into the
 * page — or into a crash reporter — would undo the whole point.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          background: "#07070c",
          color: "#e6e6f4",
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          minHeight: "100dvh",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ marginTop: "0.5rem", color: "#9a9ab8", fontSize: "0.875rem" }}>
            The details were written to the server log rather than shown here.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              borderRadius: "0.5rem",
              background: "#7c6cf0",
              color: "white",
              padding: "0.5rem 1rem",
              border: "none",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
