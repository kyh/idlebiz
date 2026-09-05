import type { ReactNode } from "react";
import { useModal } from "@/renderer/ui/modal";

/**
 * A dialog box the office cannot be used around: the room dims, the keyboard
 * sleeps, and the founder deals with what is in the box. For the moments the
 * game is stopped on — not for panels, which are Modal.
 */
export function Curtain({ children }: { children: ReactNode }) {
  useModal();
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#10121b]/90 p-6">
      <div className="px-battle w-full max-w-lg p-4">{children}</div>
    </div>
  );
}
