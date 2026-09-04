"use client";

import { useEffect } from "react";

import { StatusPage } from "@/app/status-page";

type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ErrorBoundary({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusPage
      title="Something went wrong"
      description="An unexpected error occurred. Try again — if it keeps happening, the details are in the console."
      action={
        <button type="button" onClick={reset} className="px-btn-accent">
          Try again
        </button>
      }
    />
  );
}
