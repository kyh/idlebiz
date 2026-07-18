import Link from "next/link";

const NotFound = () => (
  <main className="px-floor flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 text-center">
    <div className="space-y-2">
      <p className="text-sm text-[var(--text-dim)]">404</p>
      <h1 className="text-2xl text-[var(--light)]">Page not found</h1>
      <p className="text-[var(--text-dim)]">
        The page you&apos;re looking for doesn&apos;t exist or has moved.
      </p>
    </div>
    <Link
      href="/"
      className="px-btn-accent inline-flex items-center gap-2.5 text-[15px] uppercase tracking-wide no-underline"
    >
      Back home
    </Link>
  </main>
);

export default NotFound;
