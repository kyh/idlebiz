import type { ReactNode } from "react";
import { useModal } from "@/renderer/ui/modal";

/** Blocking overlay for onboarding, auth, and unreadable saves. */
export function Curtain({ children }: { children: ReactNode }) {
  useModal();
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#10121b]/90 p-6">
      <div className="px-battle px-pop w-full max-w-lg p-4">{children}</div>
    </div>
  );
}
