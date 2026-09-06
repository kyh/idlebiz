import { useEffect, type ReactNode } from "react";
import { setModalOpen } from "@/renderer/state/store";
import { cn } from "cn";

/** Phaser's keyboard sleeps while the caller is mounted, so typing here never walks the player. */
export function useModal(): void {
  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);
}

type ModalWidth = "lg" | "xl" | "2xl" | "3xl";
const WIDTH_CLASS = {
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
} satisfies Record<ModalWidth, string>;

/** A centred pixel window over the office: title bar, optional extra actions, Done, scrolling body. */
export function Modal({
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
}) {
  useModal();
  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6">
      <div className={cn("px-window px-pop flex max-h-[85vh] w-full flex-col", WIDTH_CLASS[width])}>
        <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
          <div>
            <div className="text-base">{title}</div>
            {subtitle ? <div className="text-xs text-[#c4c9dd]">{subtitle}</div> : null}
          </div>
          <div className="flex gap-2">
            {actions}
            <button type="button" onClick={onClose} className="px-btn">
              Done
            </button>
          </div>
        </div>
        <div className="px-scroll flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
