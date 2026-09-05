"use client";

import "@/app/globals.css";
import { ErrorStatus } from "@/app/error-status";

// Catches errors thrown by the root layout itself, so it replaces the layout
// entirely and must render its own <html>/<body> — and import the stylesheet the
// layout would have, or the kit classes below paint nothing.
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorStatus error={error} description="The application failed to load." reset={reset} />
      </body>
    </html>
  );
}
