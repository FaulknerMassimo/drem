export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-ink-100">drem</h1>
          <p className="mt-1 text-sm text-ink-400">Dream journal</p>
        </header>
        {children}
      </div>
    </div>
  );
}
