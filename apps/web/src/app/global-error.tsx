"use client";

import { useEffect } from "react";

import { StatusPage } from "@/app/status-page";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

// Catches errors thrown by the root layout itself, so it replaces the layout
// entirely and must render its own <html>/<body>. Kept dependency-free — the
// providers and fonts the app usually supplies may be exactly what failed.
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <StatusPage
          title="Something went wrong"
          description="The application failed to load."
          action={
            <button type="button" onClick={reset} className="px-btn-accent">
              Try again
            </button>
          }
        />
      </body>
    </html>
  );
}
