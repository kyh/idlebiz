import { useState } from "react";
import { bridge } from "@/renderer/bridge";
import { useStore, connectVercel, disconnectVercel } from "@/renderer/state/store";
import { Modal } from "@/renderer/ui/modal";
import { errorMessage } from "@/shared/errors";
import type { VercelProject } from "@/shared/ipc-registry";

/** What the pasted token turned up. */
type Lookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "loaded"; account: string | undefined; projects: VercelProject[] };

/** The chosen project on its way to becoming the connection. */
type Pick = { state: "idle" } | { state: "connecting" } | { state: "error"; message: string };

/**
 * Bind a product to a Vercel project with a personal access token: paste →
 * validate + list projects → pick one. The token powers the users metric (Web
 * Analytics), the product's deploy state, and the team's real `vercel` deploys.
 */
export function ConnectVercel({ productId, onClose }: { productId: string; onClose: () => void }) {
  const product = useStore((s) => s.products).find((p) => p.id === productId);
  const [token, setToken] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });
  const [pick, setPick] = useState<Pick>({ state: "idle" });
  const busy = lookup.state === "loading" || pick.state === "connecting";

  const loadProjects = async () => {
    setLookup({ state: "loading" });
    setPick({ state: "idle" });
    try {
      const res = await bridge().vercelListProjects({ token: token.trim() });
      setLookup(
        res.ok
          ? { state: "loaded", account: res.account, projects: res.projects }
          : {
              state: "error",
              message: "That token was rejected — create one at vercel.com/account/tokens.",
            },
      );
    } catch (e) {
      setLookup({ state: "error", message: errorMessage(e) });
    }
  };

  const choose = async (p: VercelProject) => {
    setPick({ state: "connecting" });
    try {
      await connectVercel(
        p.teamId
          ? {
              productId,
              token: token.trim(),
              projectId: p.id,
              projectName: p.name,
              teamId: p.teamId,
            }
          : { productId, token: token.trim(), projectId: p.id, projectName: p.name },
      );
      onClose();
    } catch (e) {
      setPick({ state: "error", message: errorMessage(e) });
    }
  };

  const problem =
    lookup.state === "error"
      ? lookup.message
      : pick.state === "error"
        ? pick.message
        : lookup.state === "loaded" && lookup.projects.length === 0
          ? "No projects on this account yet."
          : null;

  if (!product) return null;
  return (
    <Modal title="Connect Vercel" subtitle={product.name} width="lg" onClose={onClose}>
      <div className="space-y-3">
        {product.vercel ? (
          <div className="px-inset space-y-2 p-3">
            <div className="text-sm text-fg">
              ✓ <b>{product.name}</b> deploys to <b>{product.vercel.projectName}</b> — its users
              come from that project's Web Analytics, and your team deploys to it for real.
            </div>
            <button
              type="button"
              onClick={() => void disconnectVercel(productId)}
              className="px-btn"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <>
            <div className="text-sm leading-snug text-fg">
              Users are REAL — they come from Vercel Web Analytics on your deployed product. Paste a
              Vercel access token (vercel.com/account/tokens); your team also uses it to ship
              deploys.
            </div>
            <div className="flex gap-2">
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="vercel_…"
                type="password"
                className="px-field flex-1"
                autoFocus
              />
              <button
                type="button"
                onClick={() => void loadProjects()}
                disabled={busy || token.trim().length === 0}
                className="px-btn-accent px-btn"
              >
                {lookup.state === "loading" ? "Checking…" : "Continue"}
              </button>
            </div>
            {lookup.state === "loaded" && lookup.account ? (
              <div className="text-xs text-fg-dim">Signed in as {lookup.account}</div>
            ) : null}
            {lookup.state === "loaded" && lookup.projects.length > 0 ? (
              <div className="px-inset max-h-64 overflow-y-auto p-2">
                <div className="mb-1 text-xs uppercase tracking-wide text-fg-dim">
                  Pick the product's project
                </div>
                {lookup.projects.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => void choose(p)}
                    disabled={busy}
                    className="px-opt block w-full text-left"
                  >
                    {p.name}
                    {p.teamId ? <span className="ml-2 text-xs text-fg-dim">team</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
        {problem ? <div className="text-xs text-danger">{problem}</div> : null}
      </div>
    </Modal>
  );
}
