"use client";

import { ErrorStatus } from "@/app/error-status";

const ErrorBoundary = ({ error, retry }: { error: Error; retry: () => void }) => (
  <ErrorStatus
    error={error}
    description="An unexpected error occurred. Try again — if it keeps happening, the details are in the console."
    retry={retry}
  />
);

export default ErrorBoundary;
