"use client";

import { useEffect } from "react";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

// Catches errors thrown by the root layout itself, so it replaces the layout
// entirely and must render its own <html>/<body>. Kept dependency-free — the
// providers and fonts the app usually supplies may be exactly what failed.
const GlobalError = ({ error, reset }: GlobalErrorProps) => {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 text-center">
          <div className="space-y-2">
            <h1 className="text-2xl text-[var(--light)]">Something went wrong</h1>
            <p className="text-[var(--text-dim)]">The application failed to load.</p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="px-btn-accent inline-flex items-center text-[15px] uppercase tracking-wide"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
};

export default GlobalError;
