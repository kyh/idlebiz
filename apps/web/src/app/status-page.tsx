import type { ReactNode } from "react";

type StatusPageProps = {
  code?: string;
  title: string;
  description: string;
  action: ReactNode;
};

/** The centered "something is off" page shared by the error boundaries and 404. */
export function StatusPage({ code, title, description, action }: StatusPageProps) {
  return (
    <main className="px-floor flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="space-y-2">
        {code ? <p className="text-sm text-[var(--text-dim)]">{code}</p> : null}
        <h1 className="text-2xl text-[var(--light)]">{title}</h1>
        <p className="text-[var(--text-dim)]">{description}</p>
      </div>
      {action}
    </main>
  );
}
