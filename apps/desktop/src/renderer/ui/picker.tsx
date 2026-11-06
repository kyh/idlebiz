import type { ReactNode } from "react";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";

export interface PickerOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** One-of-many as a row of pressed/unpressed toggles. Base UI's ToggleGroup
 *  owns the roving focus and the pressed state; deselecting the pressed one is
 *  not a choice, so it is ignored. A null value presses none, so every option
 *  stays a choice. */
export const Picker = <T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  disabled = false,
}: {
  options: readonly PickerOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  disabled?: boolean;
}) => (
  <ToggleGroup
    value={value === null ? [] : [value]}
    onValueChange={([key]) => {
      const picked = options.find((o) => o.value === key);
      if (picked) {
        onChange(picked.value);
      }
    }}
    aria-label={label}
    className={className}
    disabled={disabled}
  >
    {options.map((o) => (
      <Toggle key={o.value} value={o.value} className="px-opt">
        {o.label}
      </Toggle>
    ))}
  </ToggleGroup>
);
