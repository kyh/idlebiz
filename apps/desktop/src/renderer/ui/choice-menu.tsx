import { useEffect, useRef } from "react";
import { Toolbar } from "@base-ui/react/toolbar";
import { cn } from "cn";

export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** A choice window's contents and what the cursor does. */
export interface Menu {
  items: readonly MenuItem[];
  cursor: number;
  setCursor: (i: number) => void;
  pick: (i: number) => void;
}

/** An RPG choice window: a list with a ▶ cursor. Base UI's Toolbar owns the
 *  roving focus (↑↓, wrapping, Enter/Space on the item); the cursor IS the
 *  focused item, and the pointer moves it by hovering. */
export const ChoiceMenu = ({ menu, className }: { menu: Menu; className?: string }) => {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const { cursor } = menu;
  // the toolbar registers its items in the render after mount, so a focus set
  // any earlier is not seen as its highlighted item; one macrotask is enough
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const item = items.current[cursor];
      if (item && document.activeElement !== item) {
        item.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cursor]);
  return (
    <Toolbar.Root
      orientation="vertical"
      className={cn("px-menu px-window px-pop", className)}
      // the item under the cursor answers Enter and Space itself; the page's
      // own Enter handler must not also fire
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
        }
      }}
    >
      {menu.items.map((item, i) => (
        <Toolbar.Button
          key={item.label}
          ref={(el) => {
            items.current[i] = el;
          }}
          className="px-menu-item"
          data-cur={i === cursor}
          // read once, when the toolbar first registers its items: the cursor's
          // item is the default tab stop rather than the first one
          data-composite-item-active={i === cursor ? "" : undefined}
          title={item.hint}
          disabled={item.disabled}
          onFocus={() => menu.setCursor(i)}
          onPointerMove={(e) => {
            if (e.pointerType !== "touch") {
              e.currentTarget.focus();
            }
          }}
          onClick={() => menu.pick(i)}
        >
          <span className="px-menu-cursor">▶</span>
          {item.label}
        </Toolbar.Button>
      ))}
    </Toolbar.Root>
  );
};
