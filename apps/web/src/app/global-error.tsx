"use client";

import "@/app/globals.css";
import { ErrorStatus } from "@/app/error-status";

const GlobalError = ({ error, retry }: { error: unknown; retry: () => void }) => (
  <html lang="en">
    <body>
      <ErrorStatus error={error} description="The application failed to load." retry={retry} />
    </body>
  </html>
);

export default GlobalError;
