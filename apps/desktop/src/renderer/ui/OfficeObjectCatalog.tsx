import { useMemo, useState } from "react";
import {
  OFFICE_OBJECT_ASSETS,
  type OfficeObjectAsset,
  type OfficeObjectVariant,
} from "@/renderer/game/office-object-catalog.generated";

type ScaleFilter = "16" | "32" | "48" | "all";

const SCALE_FILTERS: readonly ScaleFilter[] = ["32", "16", "48", "all"];

export function OfficeObjectCatalog() {
  const [query, setQuery] = useState("");
  const [scaleFilter, setScaleFilter] = useState<ScaleFilter>("32");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleAssets = useMemo(
    () =>
      OFFICE_OBJECT_ASSETS.filter(
        (asset) =>
          matchesQuery(asset, normalizedQuery) &&
          asset.variants.some((variant) => matchesScale(variant, scaleFilter)),
      ),
    [normalizedQuery, scaleFilter],
  );

  const visibleVariantCount = visibleAssets.reduce(
    (total, asset) =>
      total + asset.variants.filter((variant) => matchesScale(variant, scaleFilter)).length,
    0,
  );

  const copyId = (id: string) => {
    setCopiedId(id);
    void navigator.clipboard.writeText(id).catch(() => undefined);
    window.setTimeout(() => {
      setCopiedId((current) => (current === id ? null : current));
    }, 900);
  };

  return (
    <main className="h-full w-full bg-[#bfc2c4] text-[var(--text)]">
      <div className="flex h-full flex-col">
        <header className="px-window m-3 shrink-0 overflow-hidden">
          <div className="px-titlebar flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-[17px]">Office Objects</h1>
              <p className="text-[11px] text-[#d6d9e7]">
                {visibleAssets.length} / {OFFICE_OBJECT_ASSETS.length} objects ·{" "}
                {visibleVariantCount} sprites shown
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search id, source, size"
                className="px-field w-full min-w-0 text-[12px] sm:w-56"
              />
              <div className="flex gap-1">
                {SCALE_FILTERS.map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setScaleFilter(filter)}
                    data-sel={scaleFilter === filter}
                    className="px-opt px-2.5 py-2 text-[11px]"
                  >
                    {scaleLabel(filter)}
                  </button>
                ))}
              </div>
              <a href="#/ui" className="px-btn px-3 py-2 text-center text-[11px]">
                Builder
              </a>
              <a href="#/" className="px-btn px-3 py-2 text-center text-[11px]">
                Game
              </a>
            </div>
          </div>
        </header>

        <section className="px-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {visibleAssets.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {visibleAssets.map((asset) => (
                <ObjectCard
                  key={asset.id}
                  asset={asset}
                  scaleFilter={scaleFilter}
                  copied={copiedId === asset.id}
                  onCopy={() => copyId(asset.id)}
                />
              ))}
            </div>
          ) : (
            <div className="px-window p-6 text-[13px]">No matching office objects.</div>
          )}
        </section>
      </div>
    </main>
  );
}

function ObjectCard({
  asset,
  scaleFilter,
  copied,
  onCopy,
}: {
  asset: OfficeObjectAsset;
  scaleFilter: ScaleFilter;
  copied: boolean;
  onCopy: () => void;
}) {
  const visibleVariants = asset.variants.filter((variant) => matchesScale(variant, scaleFilter));

  return (
    <article className="px-window flex min-h-[230px] flex-col overflow-hidden">
      <div className="px-titlebar flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-[13px]">{asset.id}</h2>
          <p className="text-[10px] text-[#d6d9e7]">source {asset.sourceId}</p>
        </div>
        <button onClick={onCopy} className="px-chip shrink-0 text-[10px]">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-2 p-3">
        {visibleVariants.map((variant) => (
          <ObjectVariant key={variant.scale} variant={variant} assetId={asset.id} />
        ))}
      </div>
    </article>
  );
}

function ObjectVariant({ variant, assetId }: { variant: OfficeObjectVariant; assetId: string }) {
  return (
    <div className="px-inset flex min-h-36 flex-col gap-2 p-2">
      <div
        className="flex min-h-28 flex-1 items-center justify-center overflow-auto"
        style={{
          backgroundColor: "#d8d9d4",
          backgroundImage:
            "linear-gradient(45deg, #c7c8c2 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #c7c8c2 75%)",
          backgroundPosition: "0 0, 8px 8px",
          backgroundSize: "16px 16px",
          minHeight: variant.h + 32,
        }}
      >
        {/* oxlint-disable-next-line next/no-img-element -- Local pixel sprites in Electron. */}
        <img
          src={`/${variant.path}`}
          alt={`${assetId} ${variant.scale}x`}
          className="max-w-none shrink-0 [image-rendering:pixelated]"
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-dim)]">
        <span>{variant.scale}x</span>
        <span>
          {variant.w}x{variant.h}
        </span>
      </div>
    </div>
  );
}

function matchesQuery(asset: OfficeObjectAsset, query: string) {
  if (query.length === 0) return true;
  return (
    asset.id.includes(query) ||
    String(asset.sourceId).includes(query) ||
    asset.variants.some((variant) => `${variant.w}x${variant.h}`.includes(query))
  );
}

function matchesScale(variant: OfficeObjectVariant, scaleFilter: ScaleFilter) {
  return scaleFilter === "all" || String(variant.scale) === scaleFilter;
}

function scaleLabel(scaleFilter: ScaleFilter) {
  return scaleFilter === "all" ? "All" : `${scaleFilter}x`;
}
