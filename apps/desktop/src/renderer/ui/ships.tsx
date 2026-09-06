import { memo, useState } from "react";
import { useAsync } from "@/renderer/hooks/use-async";
import { useTransientNote } from "@/renderer/hooks/use-transient-note";
import { bridge } from "@/renderer/bridge";
import { createProduct, useStore } from "@/renderer/state/store";
import { employeeName } from "@/renderer/ui/employee-name";
import { RichText } from "@/renderer/ui/linkify";
import { productStateOf } from "@/renderer/ui/product-state";
import type { Overlay } from "@/renderer/ui/overlay";
import { Modal } from "@/renderer/ui/modal";
import { taskIn, type Product, type TaskIn } from "@/shared/domain";
import type { ProductStatus } from "@/shared/ipc-registry";
import { errorMessage } from "@/shared/errors";
import { formatDate } from "@/shared/format";
import { cn } from "cn";

const ShipRow = memo(function ShipRow({
  t,
  by,
  companyId,
}: {
  t: TaskIn<"done">;
  by: string;
  companyId: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = t.state.summary ?? "";
  const firstLine = summary.split("\n").find((l) => l.trim() !== "") ?? "";
  return (
    <div className="px-inset p-2.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <span className="text-xs text-fg-dim">{open ? "▼" : "▶"}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">📦 {firstLine || t.title}</span>
        </span>
        <span className="shrink-0 text-xs text-fg-dim">
          {by} · {formatDate(t.completedAt ?? t.createdAt)}
        </span>
      </button>
      {open ? (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[#4c5064]">
          <RichText text={summary.slice(0, 1500)} companyId={companyId} />
        </p>
      ) : null}
    </div>
  );
});

function ProductCard({
  product,
  status,
  selected,
  onSelect,
  onOpen,
  onNote,
}: {
  product: Product;
  status: ProductStatus | undefined;
  selected: boolean;
  onSelect: () => void;
  onOpen: (overlay: Overlay) => void;
  onNote: (note: string) => void;
}) {
  const state = productStateOf(status);
  const open = () =>
    bridge()
      .openProduct({ productId: product.id })
      .catch((cause) => onNote(errorMessage(cause)));
  return (
    <div className="px-inset flex min-w-0 flex-col gap-1.5 p-2.5" data-sel={selected}>
      <button type="button" onClick={onSelect} className="text-left">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-sm", selected ? "text-accent-lo" : "text-fg")}>
            {selected ? "▶ " : ""}
            {product.name}
          </span>
          <span
            className="shrink-0 text-xs uppercase"
            style={state === "LIVE" ? { color: "var(--ok)" } : undefined}
          >
            {state}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-fg-dim" title={product.description}>
          {product.description}
        </div>
        <div className="mt-0.5 text-xs text-fg-dim">
          {product.ships} shipped
          {product.users !== null ? ` · ${product.users} users` : ""}
          {status?.deploy ? ` · ${status.deploy.url}` : ""}
        </div>
      </button>
      <div className="flex gap-1.5">
        <button type="button" onClick={() => void open()} className="px-chip">
          ▶ Open
        </button>
        <button
          type="button"
          onClick={() => onOpen({ kind: "vercel", productId: product.id })}
          className="px-chip"
          title={
            product.vercel
              ? `Deploys to ${product.vercel.projectName}`
              : "Bind a Vercel project: real deploys, real users"
          }
        >
          {product.vercel ? "▲ Vercel ✓" : "▲ Vercel"}
        </button>
      </div>
    </div>
  );
}

function NewProduct({ onNote }: { onNote: (note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await createProduct(name, description);
      setName("");
      setDescription("");
      setOpen(false);
    } catch (cause) {
      onNote(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-inset flex min-h-20 items-center justify-center p-2.5 text-sm text-fg-dim"
      >
        + New product
      </button>
    );
  }
  return (
    <div className="px-inset flex flex-col gap-1.5 p-2.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        className="px-field"
        autoFocus
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What it is, in a line"
        className="px-field"
      />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={() => setOpen(false)} className="px-link">
          cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !name.trim() || !description.trim()}
          className="px-btn-accent px-btn"
        >
          Start it
        </button>
      </div>
    </div>
  );
}

export function Ships({
  onOpen,
  onClose,
}: {
  onOpen: (overlay: Overlay) => void;
  onClose: () => void;
}) {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const products = useStore((s) => s.products);
  const productStatus = useStore((s) => s.productStatus);
  const [note, showNote] = useTransientNote(2500);
  // null: the whole company's log
  const [selected, setSelected] = useState<string | null>(null);
  const ships = useAsync(
    async () =>
      company
        ? (await bridge().listTasks({ companyId: company.id, status: ["done"] }))
            .filter(taskIn("done"))
            .filter((t) => t.state.summary)
        : [],
    [company],
  );

  if (!company) return null;
  const companyId = company.id;
  // work shipped before products existed names none; it was the first product's
  const firstId = products[0]?.id;
  const ofSelected = (t: TaskIn<"done">): boolean =>
    selected === null || t.productId === selected || (t.productId === null && selected === firstId);
  const shown = ships?.filter(ofSelected) ?? null;

  const openWorkspace = () =>
    bridge()
      .openCompanyPath({ companyId, rel: "" })
      .catch((cause) => showNote(errorMessage(cause)));

  return (
    <Modal
      title="Products"
      subtitle={`${company.ships} shipped · everything your team built lives in the workspace`}
      width="3xl"
      onClose={onClose}
      actions={
        <button
          type="button"
          onClick={() => void openWorkspace()}
          className="px-btn"
          title="Reveal the real folder where the team works"
        >
          📁 Workspace
        </button>
      }
    >
      <div className="space-y-3">
        {note ? <div className="text-xs text-danger">{note}</div> : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {products.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              status={productStatus.get(p.id)}
              selected={selected === p.id}
              onSelect={() => setSelected(selected === p.id ? null : p.id)}
              onOpen={onOpen}
              onNote={showNote}
            />
          ))}
          <NewProduct onNote={showNote} />
        </div>
        <div className="text-xs uppercase tracking-wide text-fg-dim">
          Shipping log
          {selected === null ? "" : ` · ${products.find((p) => p.id === selected)?.name ?? ""}`}
        </div>
        <div className="space-y-2">
          {shown === null ? (
            <div className="text-sm text-fg-dim">Loading…</div>
          ) : shown.length === 0 ? (
            <div className="text-sm text-fg-dim">
              Nothing shipped yet — the team is just getting started.
            </div>
          ) : (
            shown
              .toReversed()
              .map((t) => (
                <ShipRow
                  key={t.id}
                  t={t}
                  by={employeeName(employees, t.assigneeId, "team")}
                  companyId={companyId}
                />
              ))
          )}
        </div>
      </div>
    </Modal>
  );
}
