"use client";

import { useEffect } from "react";
import { Cta } from "@/app/cta";
import { StatusPage } from "@/app/status-page";

export function ErrorStatus({
  error,
  description,
  reset,
}: {
  error: Error;
  description: string;
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <StatusPage
      title="Something went wrong"
      description={description}
      action={<Cta onClick={reset}>Try again</Cta>}
    />
  );
}
