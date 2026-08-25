import { useEffect, useState } from "react";
import { useStore, connectVercel, disconnectVercel, setModalOpen } from "@/renderer/state/store";
import type { VercelProjectChoice } from "@/shared/ipc-registry";

/**
 * Connect Vercel with a personal access token: paste → validate + list
 * projects → pick one. The token powers the users metric (Web Analytics),
 * the product panel's deploy state, and the team's real `vercel` deploys.
 */
export function ConnectVercel({ onClose }: { onClose: () => void }) {
  const { vercelStatus } = useStore();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [projects, setProjects] = useState<VercelProjectChoice[] | null>(null);

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  const loadProjects = async () => {
    setBusy(true);
    setError(null);
    try {
      const bridge = window.appBridge;
      if (!bridge) throw new Error("bridge unavailable");
      const res = await bridge.vercelListProjects({ token: token.trim() });
      if (!res.ok) {
        setError("That token was rejected — create one at vercel.com/account/tokens.");
        return;
      }
      setAccount(res.account);
      setProjects(res.projects);
      if (res.projects.length === 0) setError("No projects on this account yet.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (p: VercelProjectChoice) => {
    setBusy(true);
    setError(null);
    try {
      await connectVercel(
        p.teamId
          ? { token: token.trim(), projectId: p.id, projectName: p.name, teamId: p.teamId }
          : { token: token.trim(), projectId: p.id, projectName: p.name },
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6">
      <div className="px-window flex max-h-[80vh] w-full max-w-lg flex-col">
        <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
          <div className="text-base">Connect Vercel</div>
          <button type="button" onClick={onClose} className="px-btn">
            Close
          </button>
        </div>

        <div className="px-scroll space-y-3 overflow-y-auto p-4">
          {vercelStatus.state === "connected" ? (
            <div className="px-inset space-y-2 p-3">
              <div className="text-sm text-[var(--text)]">
                ✓ Connected to <b>{vercelStatus.projectName}</b> — users come from its Web
                Analytics, and your team deploys to it for real.
              </div>
              <button type="button" onClick={() => void disconnectVercel()} className="px-btn">
                Disconnect
              </button>
            </div>
          ) : (
            <>
              <div className="text-sm leading-snug text-[var(--text)]">
                Users are REAL — they come from Vercel Web Analytics on your deployed product. Paste
                a Vercel access token (vercel.com/account/tokens); your team also uses it to ship
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
                  {busy && projects === null ? "Checking…" : "Continue"}
                </button>
              </div>
              {account ? (
                <div className="text-xs text-[var(--text-dim)]">Signed in as {account}</div>
              ) : null}
              {projects && projects.length > 0 ? (
                <div className="px-inset max-h-64 overflow-y-auto p-2">
                  <div className="mb-1 text-xs uppercase tracking-wide text-[var(--text-dim)]">
                    Pick the product's project
                  </div>
                  {projects.map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      onClick={() => void pick(p)}
                      disabled={busy}
                      className="px-opt block w-full text-left"
                    >
                      {p.name}
                      {p.teamId ? (
                        <span className="ml-2 text-xs text-[var(--text-dim)]">team</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
          {error ? <div className="text-xs text-[var(--danger)]">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
