import { Toggle } from "@base-ui/react/toggle";
import type { OfficeLayer } from "@/renderer/game/office-layout";
import {
  autoAnchor,
  flipObject,
  flipTransform,
  moveObject,
  setLayer,
  srcForObject,
} from "@/renderer/ui/office-builder/office-builder-model";
import type { EditableObject } from "@/renderer/ui/office-builder/office-builder-model";

const LAYER_LABEL = {
  floor: "floor — flat, under everyone",
  object: "object — y-sorts with walkers",
  overhead: "overhead — always on top",
} satisfies Record<OfficeLayer, string>;
const LAYERS: readonly OfficeLayer[] = ["floor", "object", "overhead"];

/** Only the y-sorting band has a floor line to edit. */
const AnchorFields = ({
  obj,
  onChange,
}: {
  obj: Extract<EditableObject, { layer: "object" }>;
  onChange: (next: EditableObject) => void;
}) => (
  <>
    <label className="flex items-center justify-between gap-2">
      anchorY
      <input
        type="number"
        value={obj.anchorY}
        onChange={(e) => onChange({ ...obj, anchorY: Number(e.currentTarget.value) })}
        className="px-field w-20 text-right"
      />
    </label>
    <div className="flex gap-1">
      <button
        type="button"
        onClick={() => onChange(autoAnchor(obj))}
        className="px-btn flex-1 py-1.5"
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
      className="px-btn flex-1 py-1.5"
      title="Paint this one earlier — behind its neighbours in this layer"
    >
      Send back
    </button>
    <button
      type="button"
      onClick={() => onRestack(1)}
      className="px-btn flex-1 py-1.5"
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
  const src = srcForObject(obj);
  return (
    <div className="flex flex-col gap-2">
      <div className="px-inset flex items-center gap-2 p-2">
        {src ? (
          <img
            src={src}
            alt={obj.id}
            style={{ transform: flipTransform(obj) }}
            className="max-h-12 max-w-none [image-rendering:pixelated]"
          />
        ) : null}
        <span className="truncate">{obj.id}</span>
      </div>
      <label className="flex items-center justify-between gap-2">
        x
        <input
          type="number"
          value={obj.x}
          onChange={(e) => onChange(moveObject(obj, Number(e.currentTarget.value), obj.y))}
          className="px-field w-20 text-right"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        y
        <input
          type="number"
          value={obj.y}
          onChange={(e) => onChange(moveObject(obj, obj.x, Number(e.currentTarget.value)))}
          className="px-field w-20 text-right"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        layer
        <select
          value={obj.layer}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === "floor" || v === "object" || v === "overhead") {
              onChange(setLayer(obj, v));
            }
          }}
          className="px-field"
        >
          {LAYERS.map((l) => (
            <option key={l} value={l}>
              {LAYER_LABEL[l]}
            </option>
          ))}
        </select>
      </label>
      {obj.layer === "object" ? (
        <AnchorFields obj={obj} onChange={onChange} />
      ) : (
        <StackButtons onRestack={onRestack} />
      )}
      <div className="flex gap-1">
        <Toggle
          pressed={obj.flipX}
          onPressedChange={() => onChange(flipObject(obj, "x"))}
          className="px-opt flex-1 py-1.5"
          title="Flip horizontal (⇧H)"
        >
          Flip H
        </Toggle>
        <Toggle
          pressed={obj.flipY}
          onPressedChange={() => onChange(flipObject(obj, "y"))}
          className="px-opt flex-1 py-1.5"
          title="Flip vertical (⇧V)"
        >
          Flip V
        </Toggle>
      </div>
      <button type="button" onClick={onDelete} className="px-btn px-btn-danger py-1.5">
        Delete
      </button>
    </div>
  );
};
