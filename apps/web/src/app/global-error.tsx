"use client";

import { useEffect } from "react";

import "@/app/globals.css";
import { StatusPage } from "@/app/status-page";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

// Catches errors thrown by the root layout itself, so it replaces the layout
// entirely and must render its own <html>/<body> — and import the stylesheet the
// layout would have, or the kit classes below paint nothing.
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
