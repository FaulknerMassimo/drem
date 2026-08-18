export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Your journal</h2>
        <p className="mt-1 text-ink-400">
          The security foundation is in place. Entries, the activity heatmap and
          the AI features arrive in the next phases.
        </p>
      </div>

      <div className="card">
        <h3 className="font-medium">Unlocked</h3>
        <p className="mt-2 text-sm text-ink-400">
          Your data key is held in memory for this session only. Locking, or
          restarting the server, discards it.
        </p>
      </div>
    </div>
  );
}
