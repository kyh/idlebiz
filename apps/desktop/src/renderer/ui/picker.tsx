import type { ReactNode } from "react";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { cn } from "cn";

export interface PickerOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

/** One-of-many as a row of pressed/unpressed toggles. Base UI's ToggleGroup
 *  owns the roving focus and the pressed state; deselecting the pressed one is
 *  not a choice, so it is ignored. */
export const Picker = <T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  itemClassName,
}: {
  options: readonly PickerOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  itemClassName?: string;
}) => (
  <ToggleGroup
    value={[value]}
    onValueChange={([key]) => {
      const picked = options.find((o) => o.value === key);
      if (picked) {
        onChange(picked.value);
      }
    }}
    aria-label={label}
    className={className}
  >
    {options.map((o) => (
      <Toggle key={o.value} value={o.value} title={o.title} className={cn("px-opt", itemClassName)}>
        {o.label}
      </Toggle>
    ))}
  </ToggleGroup>
);
