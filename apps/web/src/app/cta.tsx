import Link from "next/link";
import type { ReactNode } from "react";

const CTA_CLASS =
  "px-btn px-btn-accent inline-flex items-center gap-2.5 uppercase tracking-wide no-underline";

export function Cta(props: { children: ReactNode } & ({ href: string } | { onClick: () => void })) {
  if ("href" in props) {
    return (
      <Link href={props.href} className={CTA_CLASS}>
        {props.children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={props.onClick} className={CTA_CLASS}>
      {props.children}
    </button>
  );
}
