import { useEffect, useState } from "react";
import { bridge } from "@/renderer/bridge";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { useStore, connectVercel, disconnectVercel } from "@/renderer/state/store";
import { ChoiceMenu } from "@/renderer/ui/choice-menu";
import { Failure } from "@/renderer/ui/failure";
import { Modal } from "@/renderer/ui/modal";
import { errorMessage } from "@/shared/errors";
import type { VercelProject } from "@/shared/integrations";

type Lookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "loaded";
      account: string | undefined;
      projects: VercelProject[];
      /** The token that listed them; absent when it is the saved one. */
      token?: string;
    };

const problemOf = (lookup: Lookup): string | null => {
  if (lookup.state === "error") {
    return lookup.message;
  }
  if (lookup.state === "loaded" && lookup.projects.length === 0) {
    return "No projects on this account yet.";
  }
  return null;
};

// One token serves every product, so a product is bound with the saved one
// unless the founder pastes another.
const PickProject = ({ productId, onClose }: { productId: string; onClose: () => void }) => {
  const [token, setToken] = useState("");
  const [cursor, setCursor] = useState(0);
  const [lookup, setLookup] = useState<Lookup>({ state: "loading" });
  const connecting = useSubmission(
    async ({ project, given }: { project: VercelProject; given: string | undefined }) => {
      await connectVercel({
        productId,
        projectId: project.id,
        projectName: project.name,
        teamId: project.teamId,
        token: given,
      });
      onClose();
    },
  );
  const busy = lookup.state === "loading" || connecting.submission.kind === "sending";

  useEffect(() => {
    let current = true;
    const trySaved = async () => {
      const res = await bridge()
        .vercelListProjects({})
        .catch(() => null);
      if (current) {
        setLookup(
          res?.ok
            ? { account: res.account, projects: res.projects, state: "loaded" }
            : { state: "idle" },
        );
      }
    };
    void trySaved();
    return () => {
      current = false;
    };
  }, []);

  const loadProjects = async () => {
    const given = token.trim();
    setLookup({ state: "loading" });
    try {
      const res = await bridge().vercelListProjects({ token: given });
      setLookup(
        res.ok
          ? { account: res.account, projects: res.projects, state: "loaded", token: given }
          : {
              message: "That token was rejected — create one at vercel.com/account/tokens.",
              state: "error",
            },
      );
    } catch (error) {
      setLookup({ message: errorMessage(error), state: "error" });
    }
  };

  const saved = lookup.state === "loaded" && lookup.token === undefined;
  const problem = problemOf(lookup);

  return (
    <>
      <div className="text-sm leading-snug text-fg">
        {saved
          ? "Users are REAL — they come from Vercel Web Analytics on your deployed product. Pick its project, seen with your saved Vercel token; a different token replaces it for every product."
          : "Users are REAL — they come from Vercel Web Analytics on your deployed product. Paste a Vercel access token (vercel.com/account/tokens); your team also uses it to ship deploys."}
      </div>
      <div className="flex gap-2">
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={saved ? "use a different token: vercel_…" : "vercel_…"}
          type="password"
          className="px-field flex-1"
          autoFocus
        />
        <button
          type="button"
          onClick={() => {
            void loadProjects();
          }}
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
            Pick the product&apos;s project
          </div>
          <ChoiceMenu
            menu={{
              cursor,
              items: lookup.projects.map((p) => ({
                disabled: busy,
                hint: p.teamId ? "a team project" : undefined,
                label: p.name,
              })),
              pick: (i) => {
                const project = lookup.projects[i];
                if (project) {
                  connecting.submit({ given: lookup.token, project });
                }
              },
              setCursor,
            }}
            className="w-full"
          />
        </div>
      ) : null}
      <Failure submission={connecting.submission} doing="connect" />
      {problem ? <div className="text-xs text-danger">{problem}</div> : null}
    </>
  );
};

// The token also powers product metrics and the team's deployments.
export const ConnectVercel = ({
  productId,
  onClose,
}: {
  productId: string;
  onClose: () => void;
}) => {
  const product = useStore((s) => s.products).find((p) => p.id === productId);
  const disconnecting = useSubmission(() => disconnectVercel(productId));

  if (!product) {
    return null;
  }
  return (
    <Modal title="Connect Vercel" subtitle={product.name} width="lg" onClose={onClose}>
      <div className="space-y-3">
        {product.vercel ? (
          <div className="px-inset space-y-2 p-3">
            <div className="text-sm text-fg">
              ✓ <b>{product.name}</b> deploys to <b>{product.vercel.projectName}</b> — its users
              come from that project&apos;s Web Analytics, and your team deploys to it for real.
            </div>
            <button
              type="button"
              onClick={() => disconnecting.submit()}
              disabled={disconnecting.submission.kind === "sending"}
              className="px-btn"
            >
              Disconnect
            </button>
            <Failure submission={disconnecting.submission} doing="disconnect" />
          </div>
        ) : (
          <PickProject productId={productId} onClose={onClose} />
        )}
      </div>
    </Modal>
  );
};
