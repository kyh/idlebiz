import { NumberField } from "@base-ui/react/number-field";
import { Toggle } from "@base-ui/react/toggle";
import { useEffect, useEffectEvent, useId, useRef } from "react";
import type { OfficeLayer } from "@/renderer/game/office-layout";
import {
  autoAnchor,
  flipObject,
  flipTransform,
  moveObject,
  setLayer,
} from "@/renderer/ui/office-builder/office-builder-model";
import type { EditableObject } from "@/renderer/ui/office-builder/office-builder-model";
import { objectSpritePath } from "@/shared/office-object-sprite";
import { Picker } from "@/renderer/ui/picker";
import type { PickerOption } from "@/renderer/ui/picker";

const LAYER_OPTIONS: readonly PickerOption<OfficeLayer>[] = [
  { label: "floor", title: "Flat, under everyone", value: "floor" },
  { label: "object", title: "Y-sorts with walkers", value: "object" },
  { label: "overhead", title: "Always on top", value: "overhead" },
];

const PLAIN_NUMBER: Intl.NumberFormatOptions = { useGrouping: false };

/**
 * Commits on blur or an arrow step, so one edit is one undo step and a cleared
 * field is no edit rather than a move to 0. Clicking another object remounts
 * the Inspector before this field blurs, so a typed value still pending then
 * is committed on the way out instead of dropped.
 */
const CoordField = ({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (next: number) => void;
}) => {
  const id = useId();
  const pending = useRef<number | null>(null);
  const commit = (next: number | null) => {
    pending.current = null;
    if (next !== null && next !== value) {
      onCommit(next);
    }
  };
  const flush = useEffectEvent(() => commit(pending.current));
  useEffect(() => () => flush(), []);
  return (
    <NumberField.Root
      id={id}
      value={value}
      format={PLAIN_NUMBER}
      onValueChange={(next) => {
        pending.current = next;
      }}
      onValueCommitted={commit}
      className="flex items-center justify-between gap-2"
    >
      <label htmlFor={id}>{label}</label>
      <NumberField.Input className="px-field w-20 text-right" />
    </NumberField.Root>
  );
};

/** Only the y-sorting band has a floor line to edit. */
const AnchorFields = ({
  obj,
  onChange,
}: {
  obj: Extract<EditableObject, { layer: "object" }>;
  onChange: (next: EditableObject) => void;
}) => (
  <>
    <CoordField
      label="anchorY"
      value={obj.anchorY}
      onCommit={(anchorY) => onChange({ ...obj, anchorY })}
    />
    <div className="flex gap-1">
      <button
        type="button"
        onClick={() => onChange(autoAnchor(obj))}
        className="px-btn flex-1"
        title="Snap the anchor back to the sprite's floor line"
      >
        Auto anchor
      </button>
    </div>
  </>
);

/** The flat bands paint in list order, so what they get is a way to move within that order. */
const StackButtons = ({ onRestack }: { onRestack: (dir: 1 | -1) => void }) => (
  <div className="flex gap-1">
    <button
      type="button"
      onClick={() => onRestack(-1)}
      className="px-btn flex-1"
      title="Paint this one earlier — behind its neighbours in this layer"
    >
      Send back
    </button>
    <button
      type="button"
      onClick={() => onRestack(1)}
      className="px-btn flex-1"
      title="Paint this one later — in front of its neighbours in this layer"
    >
      Bring forward
    </button>
  </div>
);

export const Inspector = ({
  obj,
  onChange,
  onRestack,
  onDelete,
}: {
  obj: EditableObject;
  onChange: (next: EditableObject) => void;
  onRestack: (dir: 1 | -1) => void;
  onDelete: () => void;
}) => {
  const src = objectSpritePath(obj);
  return (
    <div className="flex flex-col gap-2">
      <div className="px-inset flex items-center gap-2 p-2">
        <img
          src={src}
          alt={obj.id}
          style={{ transform: flipTransform(obj) }}
          className="max-h-12 max-w-none [image-rendering:pixelated]"
        />
        <span className="truncate">{obj.id}</span>
      </div>
      <CoordField label="x" value={obj.x} onCommit={(x) => onChange(moveObject(obj, x, obj.y))} />
      <CoordField label="y" value={obj.y} onCommit={(y) => onChange(moveObject(obj, obj.x, y))} />
      <Picker
        options={LAYER_OPTIONS}
        value={obj.layer}
        onChange={(layer) => onChange(setLayer(obj, layer))}
        label="Layer"
        className="flex gap-1"
        itemClassName="flex-1"
      />
      {obj.layer === "object" ? (
        <AnchorFields obj={obj} onChange={onChange} />
      ) : (
        <StackButtons onRestack={onRestack} />
      )}
      <div className="flex gap-1">
        <Toggle
          pressed={obj.flipX}
          onPressedChange={() => onChange(flipObject(obj, "x"))}
          className="px-opt flex-1"
          title="Flip horizontal (⇧H)"
        >
          Flip H
        </Toggle>
        <Toggle
          pressed={obj.flipY}
          onPressedChange={() => onChange(flipObject(obj, "y"))}
          className="px-opt flex-1"
          title="Flip vertical (⇧V)"
        >
          Flip V
        </Toggle>
      </div>
      <button type="button" onClick={onDelete} className="px-btn px-btn-danger">
        Delete
      </button>
    </div>
  );
};
