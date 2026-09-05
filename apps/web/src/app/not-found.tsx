import Link from "next/link";

import { StatusPage } from "@/app/status-page";

export default function NotFound() {
  return (
    <StatusPage
      code="404"
      title="Page not found"
      description="The page you're looking for doesn't exist or has moved."
      action={
        <Link
          href="/"
          className="px-btn px-btn-accent inline-flex items-center gap-2.5 uppercase tracking-wide no-underline"
        >
          Back home
        </Link>
      }
    />
  );
}
