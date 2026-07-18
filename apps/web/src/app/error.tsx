"use client";

import { useEffect } from "react";

type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

const ErrorBoundary = ({ error, reset }: ErrorBoundaryProps) => {
  useEffect(() => {
    // Replace with your error reporting service
    console.error(error);
  }, [error]);

  return (
    <main className="px-floor flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl text-[var(--light)]">Something went wrong</h1>
        <p className="text-[var(--text-dim)]">
          An unexpected error occurred. Try again — if it keeps happening, the details are in the
          console.
        </p>
      </div>
      <button
        type="button"
        onClick={reset}
        className="px-btn-accent inline-flex items-center gap-2.5 text-[15px] uppercase tracking-wide"
      >
        Try again
      </button>
    </main>
  );
};

export default ErrorBoundary;
