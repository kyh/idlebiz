"use client";

import { ErrorStatus } from "@/app/error-status";

export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorStatus
      error={error}
      description="An unexpected error occurred. Try again — if it keeps happening, the details are in the console."
      reset={reset}
    />
  );
}
