import Link from "next/link";

/** The frame every signed-in page sits in. */
export function Shell({
  children,
  email,
  title,
}: {
  children: React.ReactNode;
  email: string;
  title?: string;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between gap-4">
            <div className="flex items-center gap-6 min-w-0">
              <Link href="/" className="font-semibold tracking-tight shrink-0">
                Practice Manager
              </Link>
              <nav className="flex items-center gap-4 text-sm min-w-0">
                <Link href="/" className="text-ink-soft hover:text-ink whitespace-nowrap">
                  Today
                </Link>
                <Link href="/clients" className="text-ink-soft hover:text-ink whitespace-nowrap">
                  Clients
                </Link>
                <Link href="/library" className="text-ink-soft hover:text-ink whitespace-nowrap">
                  Library
                </Link>
              </nav>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <span className="hidden sm:block text-xs text-ink-faint truncate max-w-[180px]">
                {email}
              </span>
              <form action="/auth/signout" method="post">
                <button type="submit" className="text-xs text-ink-soft hover:text-ink">
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-6 sm:py-8">
        {title && <h1 className="text-lg font-semibold tracking-tight mb-5">{title}</h1>}
        {children}
      </main>
    </div>
  );
}
