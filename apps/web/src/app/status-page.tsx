import type { ReactNode } from "react";

type StatusPageProps = {
  code?: string;
  title: string;
  description: string;
  action: ReactNode;
};

export function StatusPage({ code, title, description, action }: StatusPageProps) {
  return (
    <main className="px-floor flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="space-y-2">
        {code ? <p className="text-sm text-fg-dim">{code}</p> : null}
        <h1 className="text-2xl text-light">{title}</h1>
        <p className="text-fg-dim">{description}</p>
      </div>
      {action}
    </main>
  );
}
