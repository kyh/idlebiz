import { useRef } from "react";
import type { ReactNode } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useModal } from "@/renderer/ui/modal";

/**
 * A screen the founder can't dismiss, only resolve: an unreadable save, or no
 * signed-in CLI. Base UI's AlertDialog traps focus and makes the office inert;
 * children name it with `AlertDialog.Title`.
 */
export const Curtain = ({ children }: { children: ReactNode }) => {
  useModal();
  // focus rests on the window itself, not on its button, so nothing looks pressed on open
  const popup = useRef<HTMLDivElement>(null);
  // .px-battle sets position on the popup, so the viewport around it does the centring
  return (
    <AlertDialog.Root open>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-[#10121b]/90" />
        <AlertDialog.Viewport className="fixed inset-0 z-40 flex items-center justify-center p-6">
          <AlertDialog.Popup
            ref={popup}
            initialFocus={popup}
            className="px-battle px-pop w-full max-w-lg p-4 outline-none"
          >
            {children}
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
};
