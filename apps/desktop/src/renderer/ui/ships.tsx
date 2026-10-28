import { memo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { api, orpc } from "@/renderer/api";
import {
  useBets,
  useCompany,
  useEmployees,
  useProductStatus,
  useProducts,
} from "@/renderer/state/queries";
import { createProduct } from "@/renderer/state/store";
import { BetList } from "@/renderer/ui/bets";
import { ConfirmLink } from "@/renderer/ui/confirm-link";
import { Failure } from "@/renderer/ui/failure";
import { employeeName } from "@/renderer/ui/employee-name";
import { RichText } from "@/renderer/ui/linkify";
import { deploymentOf, productStateOf } from "@/renderer/ui/product-state";
import type { Overlay } from "@/renderer/ui/overlay";
import { Modal } from "@/renderer/ui/modal";
import type { Employee, Product, ShipLine } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";
import { formatDate, formatUsd } from "@repo/domain/format";
import { cn } from "cn";

const ShipRowView = ({ t, by }: { t: ShipLine; by: string }) => {
  const [open, setOpen] = useState(false);
  const firstLine = t.summary.split("\n").find((l) => l.trim() !== "") ?? "";
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
          {by} · {formatDate(t.completedAt)}
        </span>
      </button>
      {open ? (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-fg-mid select-text">
          <RichText text={t.summary} />
        </p>
      ) : null}
    </div>
  );
};
const ShipRow = memo(ShipRowView);

const ShippingLog = ({
  log,
  selected,
  employees,
}: {
  log: UseQueryResult<ShipLine[]>;
  selected: string | null;
  employees: Employee[];
}) => {
  if (log.isPending) {
    return <div className="text-sm text-fg-dim">Loading…</div>;
  }
  if (log.isError) {
    return <div className="text-sm text-fg-dim">{errorMessage(log.error)}</div>;
  }
  const shown = log.data.filter((t) => selected === null || t.productId === selected);
  if (shown.length === 0) {
    return (
      <div className="text-sm text-fg-dim">
        Nothing shipped yet — the team is just getting started.
      </div>
    );
  }
  return shown.map((t) => (
    <ShipRow key={t.id} t={t} by={employeeName(employees, t.assigneeId, "team")} />
  ));
};

const ProductCard = ({
  product,
  selected,
  retirable,
  onSelect,
  onOpen,
}: {
  product: Product;
  selected: boolean;
  /** The last product stays: a company with none is handed a fresh one at boot. */
  retirable: boolean;
  onSelect: () => void;
  onOpen: (overlay: Overlay) => void;
}) => {
  const status = useProductStatus(product.id);
  const state = productStateOf(status);
  const deploy = deploymentOf(status);
  const opening = useSubmission(() => api.products.open({ productId: product.id }));
  // main answers with `product.killed`, and that event refetches what moved
  const retire = async () => {
    await api.products.kill({ productId: product.id, reason: "the founder retired it" });
  };
  return (
    <div className="px-inset flex min-w-0 flex-col gap-1.5 p-2.5">
      <button type="button" onClick={onSelect} className="text-left">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-sm", selected ? "text-accent-lo" : "text-fg")}>
            {selected ? "▶ " : ""}
            {product.name}
          </span>
          <span className={cn("shrink-0 text-xs uppercase", state === "LIVE" && "text-ok")}>
            {state}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-fg-dim" title={product.description}>
          {product.description}
        </div>
        <div className="mt-0.5 text-xs text-fg-dim">
          {product.ships} shipped
          {product.users === null ? "" : ` · ${product.users} users`}
          {product.revenueUsd === null ? "" : ` · ${formatUsd(product.revenueUsd)}`}
          {deploy ? ` · ${deploy.url}` : ""}
        </div>
      </button>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => opening.submit()}
          disabled={opening.submission.kind === "sending"}
          className="px-chip"
        >
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
        {retirable ? (
          <ConfirmLink
            label="retire"
            confirmLabel="retire it"
            title="Archive it under retired/, switch off its payment links and free its budget"
            className="ml-auto"
            onConfirm={retire}
          />
        ) : null}
      </div>
      <Failure submission={opening.submission} doing={`open ${product.name}`} />
    </div>
  );
};

const NewProduct = () => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { submission, submit } = useSubmission(async () => {
    await createProduct(name, description);
    setName("");
    setDescription("");
    setOpen(false);
  });
  const busy = submission.kind === "sending";
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
          onClick={() => submit()}
          disabled={busy || !name.trim() || !description.trim()}
          className="px-btn-accent px-btn"
        >
          Start it
        </button>
      </div>
      <Failure submission={submission} />
    </div>
  );
};

export const Ships = ({
  onOpen,
  onClose,
}: {
  onOpen: (overlay: Overlay) => void;
  onClose: () => void;
}) => {
  const company = useCompany();
  const employees = useEmployees();
  const products = useProducts();
  const bets = useBets();
  const [picked, setPicked] = useState<string | null>(null);
  const opening = useSubmission((rel: string) => api.company.openPath({ rel }));
  const log = useQuery({ ...orpc.tasks.shipped.queryOptions(), enabled: company !== null });

  if (!company) {
    return null;
  }
  // a pick retired since reads as none: the whole company
  const selectedProduct = products.find((p) => p.id === picked);
  const selected = selectedProduct?.id ?? null;
  const selectedName = selectedProduct ? ` · ${selectedProduct.name}` : "";

  return (
    <Modal
      title="Products"
      subtitle={`${company.ships} shipped · everything your team built lives in the workspace`}
      width="3xl"
      onClose={onClose}
      actions={
        <button
          type="button"
          onClick={() => opening.submit(selectedProduct?.workspaceDir ?? "")}
          disabled={opening.submission.kind === "sending"}
          className="px-btn"
          title={
            selectedProduct
              ? `Open the real folder where ${selectedProduct.name} is built`
              : "Open the real folder the team shares across products"
          }
        >
          📁 Workspace
        </button>
      }
    >
      <div className="space-y-3">
        <Failure submission={opening.submission} doing="open the workspace" />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {products.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              selected={selected === p.id}
              retirable={products.length > 1}
              onSelect={() => setPicked(selected === p.id ? null : p.id)}
              onOpen={onOpen}
            />
          ))}
          <NewProduct />
        </div>
        <div className="px-label text-fg-dim">Bets{selectedName}</div>
        <div className="space-y-2">
          <BetList bets={bets.filter((b) => selected === null || b.productId === selected)} />
        </div>
        <div className="px-label text-fg-dim">Shipping log{selectedName}</div>
        <div className="space-y-2">
          <ShippingLog log={log} selected={selected} employees={employees} />
        </div>
      </div>
    </Modal>
  );
};
