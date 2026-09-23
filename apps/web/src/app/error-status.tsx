"use client";

import { useEffect } from "react";
import { Cta } from "@/app/cta";
import { StatusPage } from "@/app/status-page";

export const ErrorStatus = ({
  error,
  description,
  retry,
}: {
  error: Error;
  description: string;
  retry: () => void;
}) => {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <StatusPage
      title="Something went wrong"
      description={description}
      action={<Cta onClick={retry}>Try again</Cta>}
    />
  );
};
