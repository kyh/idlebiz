"use client";

import "@/app/globals.css";
import { ErrorStatus } from "@/app/error-status";

// This boundary replaces the root layout, including its document shell and stylesheet.
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorStatus error={error} description="The application failed to load." reset={reset} />
      </body>
    </html>
  );
}
