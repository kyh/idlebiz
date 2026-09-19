import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { setModalOpen } from "@/renderer/state/store";
import { cn } from "cn";

const openModals = new Set<symbol>();

/** Overlapping overlays keep Phaser's keyboard suspended until the last one closes. */
export const useModal = (): void => {
  useEffect(() => {
    const modal = Symbol("modal");
    openModals.add(modal);
    setModalOpen(true);
    return () => {
      openModals.delete(modal);
      setModalOpen(openModals.size > 0);
    };
  }, []);
};

type ModalWidth = "lg" | "xl" | "2xl" | "3xl";
const WIDTH_CLASS = {
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  lg: "max-w-lg",
  xl: "max-w-xl",
} satisfies Record<ModalWidth, string>;

/** A window over the office. Base UI's Dialog owns the interaction — Escape,
 *  the backdrop click, the focus trap — and the kit owns the look. */
export const Modal = ({
  title,
  subtitle,
  width = "xl",
  actions,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  width?: ModalWidth;
  /** Buttons that sit beside Done in the title bar. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) => {
  useModal();
  // focus rests on the window itself, not on Done, so nothing looks pressed on open
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="px-backdrop" />
        <Dialog.Popup
          ref={popup}
          initialFocus={popup}
          className={cn("px-window px-pop px-dialog", WIDTH_CLASS[width])}
        >
          <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
            <div>
              <Dialog.Title className="text-base">{title}</Dialog.Title>
              {subtitle ? (
                <Dialog.Description className="text-xs text-[#c4c9dd]">
                  {subtitle}
                </Dialog.Description>
              ) : null}
            </div>
            <div className="flex gap-2">
              {actions}
              <Dialog.Close className="px-btn">Done</Dialog.Close>
            </div>
          </div>
          <div className="px-scroll flex-1 overflow-y-auto p-4">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
