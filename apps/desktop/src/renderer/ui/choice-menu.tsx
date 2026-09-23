import { useEffect, useEffectEvent, useRef } from "react";
import { Toolbar } from "@base-ui/react/toolbar";
import { cn } from "cn";

export interface MenuItem {
  /** Tells rows apart when labels may repeat; the label otherwise. */
  id?: string;
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

const isTextField = (el: Element | null): boolean =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

/** An RPG choice window: a list with a ▶ cursor. Base UI's Toolbar owns the
 *  roving focus (↑↓, wrapping, Enter/Space on the item); the cursor IS the
 *  focused item, and the pointer moves it by hovering. The focused item answers
 *  Enter and Space itself, so the page's own Enter handler must not also fire.
 *  `data-composite-item-active` is read once, when the toolbar first registers
 *  its items: it makes the cursor's item the default tab stop, not the first.
 *  `refocusKey` names whatever beside the menu can hold focus (an answer box):
 *  when it changes and that left focus on the body, the cursor's row takes it. */
export const ChoiceMenu = ({
  menu,
  className,
  refocusKey = null,
}: {
  menu: Menu;
  className?: string;
  refocusKey?: string | null;
}) => {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const { cursor } = menu;
  // the toolbar registers its items in the render after mount, so a focus set
  // any earlier is not seen as its highlighted item; one macrotask is enough.
  // A text field that took focus in the same commit (an autoFocus answer box)
  // keeps it.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const item = items.current[cursor];
      const focused = document.activeElement;
      if (item && focused !== item && !isTextField(focused)) {
        item.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cursor]);

  // Base UI keeps its highlight on the same element as rows come and go around
  // it, while the cursor is an index: follow the element. A focused row that
  // went away left focus on the body, so hand it back to the cursor's row.
  const reconcile = useEffectEvent(() => {
    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      items.current[Math.min(cursor, menu.items.length - 1)]?.focus();
      return;
    }
    const at = focused instanceof HTMLButtonElement ? items.current.indexOf(focused) : -1;
    if (at !== -1 && at !== cursor) {
      menu.setCursor(at);
    }
  });
  const labels = menu.items.map((item) => item.label).join("\n");
  useEffect(() => {
    const timer = window.setTimeout(() => reconcile(), 0);
    return () => window.clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the rows' labels and refocusKey are the trigger; what runs reads the DOM they rendered
  }, [labels, refocusKey]);

  return (
    <Toolbar.Root
      orientation="vertical"
      className={cn("px-menu px-window px-pop", className)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
        }
      }}
    >
      {menu.items.map((item, i) => (
        <Toolbar.Button
          key={item.id ?? item.label}
          ref={(el) => {
            items.current[i] = el;
          }}
          className="px-menu-item"
          data-cur={i === cursor}
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
