import { useMemo, useState } from "react";
import { useTransientNote } from "@/renderer/hooks/use-transient-note";
import {
  OFFICE_OBJECT_ASSETS,
  type OfficeObjectAsset,
} from "@/renderer/game/office-object-catalog.generated";

export function OfficeObjectCatalog() {
  const [query, setQuery] = useState("");
  const [copiedId, flashCopied] = useTransientNote(900);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleAssets = useMemo(
    () => OFFICE_OBJECT_ASSETS.filter((asset) => matchesQuery(asset, normalizedQuery)),
    [normalizedQuery],
  );

  const copyId = (id: string) => {
    flashCopied(id);
    void navigator.clipboard.writeText(id).catch(() => undefined);
  };

  return (
    <main className="h-full w-full bg-[#bfc2c4] text-fg">
      <div className="flex h-full flex-col">
        <header className="px-window m-3 shrink-0 overflow-hidden">
          <div className="px-titlebar flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-base">Office Objects</h1>
              <p className="text-xs text-[#d6d9e7]">
                {visibleAssets.length} / {OFFICE_OBJECT_ASSETS.length} objects
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search id, source, size"
                className="px-field w-full min-w-0 sm:w-56"
              />
              <a href="#/ui" className="px-btn px-3 py-2 text-center">
                Builder
              </a>
              <a href="#/" className="px-btn px-3 py-2 text-center">
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
                  copied={copiedId === asset.id}
                  onCopy={() => copyId(asset.id)}
                />
              ))}
            </div>
          ) : (
            <div className="px-window p-6 text-sm">No matching office objects.</div>
          )}
        </section>
      </div>
    </main>
  );
}

function ObjectCard({
  asset,
  copied,
  onCopy,
}: {
  asset: OfficeObjectAsset;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <article className="px-window flex min-h-[230px] flex-col overflow-hidden">
      <div className="px-titlebar flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm">{asset.id}</h2>
          <p className="text-xs text-[#d6d9e7]">source {asset.sourceId}</p>
        </div>
        <button type="button" onClick={onCopy} className="px-chip shrink-0">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="px-inset m-3 flex min-h-36 flex-1 flex-col gap-2 p-2">
        <div
          className="flex min-h-28 flex-1 items-center justify-center overflow-auto"
          style={{
            backgroundColor: "#d8d9d4",
            backgroundImage:
              "linear-gradient(45deg, #c7c8c2 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #c7c8c2 75%)",
            backgroundPosition: "0 0, 8px 8px",
            backgroundSize: "16px 16px",
            minHeight: asset.h + 32,
          }}
        >
          <img
            src={`/${asset.path}`}
            alt={asset.id}
            className="max-w-none shrink-0 [image-rendering:pixelated]"
          />
        </div>
        <div className="text-right text-xs text-fg-dim">
          {asset.w}x{asset.h}
        </div>
      </div>
    </article>
  );
}

function matchesQuery(asset: OfficeObjectAsset, query: string) {
  if (query.length === 0) return true;
  return (
    asset.id.includes(query) ||
    String(asset.sourceId).includes(query) ||
    `${asset.w}x${asset.h}`.includes(query)
  );
}
