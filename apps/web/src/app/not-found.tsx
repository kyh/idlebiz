import { Cta } from "@/app/cta";
import { StatusPage } from "@/app/status-page";

export default function NotFound() {
  return (
    <StatusPage
      code="404"
      title="Page not found"
      description="The page you're looking for doesn't exist or has moved."
      action={<Cta href="/">Back home</Cta>}
    />
  );
}
