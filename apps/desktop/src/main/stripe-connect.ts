import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  ConnectedAccountSchema,
  DEAUTHORIZE_PATH,
  LOOPBACK_CALLBACK_PATH,
  authorizeUrl,
  parseCallback,
} from "@repo/stripe-connect-protocol/protocol";
import type { ConnectedAccount, DeauthorizeBody } from "@repo/stripe-connect-protocol/protocol";
import { newKeyring, open } from "@repo/stripe-connect-protocol/seal";
import type { Keyring } from "@repo/stripe-connect-protocol/seal";
import { listenLoopback } from "@/main/lib/http";
import { getSecret, setSecret, deleteSecret } from "@/main/secrets";
import { readMetricsConfig, writeMetricsConfig } from "@/main/store/metrics-config";
import { requireCompany } from "@/main/store/store";
import { errorMessage } from "@/shared/errors";
import type { StripeStatus } from "@/shared/integrations";

// The web callback exchanges the OAuth code and seals the read-only token for
// this loopback flow. The platform secret stays on the web server.

const WEB_BASE = process.env["IDLEBIZ_WEB_URL"] ?? "https://idlebiz.com";
const FLOW_TIMEOUT_MS = 5 * 60_000;
const STRIPE_TOKEN_KEY = "STRIPE_CONNECT_TOKEN";

type Revocation = { kind: "revoked" } | { kind: "unconfirmed"; reason: string };

interface PendingFlow {
  companyId: string;
  server: Server;
  nonce: string;
  /** This flow's key pair; the private half dies with the flow. */
  ring: Keyring;
  timeout: ReturnType<typeof setTimeout>;
}

let pending: PendingFlow | null = null;
let generation = 0;
let revoking: Promise<Revocation> | null = null;
let lastError: string | null = null;

type Notify = (status: StripeStatus) => void;
let notify: Notify = () => {
  /* empty */
};
let onConnected: (companyId: string) => void = () => {
  /* empty */
};
let openExternal: (url: string) => Promise<void> = () =>
  Promise.reject(new Error("Stripe Connect is not initialized"));

export const initStripeConnect = (hooks: {
  notify: Notify;
  onConnected: (companyId: string) => void;
  openExternal: (url: string) => Promise<void>;
}): void => {
  ({ notify, onConnected, openExternal } = hooks);
};

export const getStripeStatus = (companyId: string): StripeStatus => {
  if (pending) {
    return { state: "connecting" };
  }
  if (lastError) {
    return { message: lastError, state: "error" };
  }
  const account = readMetricsConfig(companyId)?.stripeAccount;
  if (account && getSecret(STRIPE_TOKEN_KEY)) {
    return { accountId: account.accountId, livemode: account.livemode, state: "connected" };
  }
  return { state: "disconnected" };
};

const fail = (message: string): void => {
  lastError = message;
  notify({ message, state: "error" });
};

/** The metrics pulse saw a 401 — surface it without deleting the token. */
export const markAuthError = (message: string): void => {
  if (lastError !== message) {
    fail(message);
  }
};

const closeFlow = (flow: PendingFlow): void => {
  clearTimeout(flow.timeout);
  try {
    flow.server.close();
  } catch {
    /* already closed */
  }
  if (pending === flow) {
    pending = null;
  }
};

const cancelPending = (): number => {
  generation += 1;
  if (pending) {
    closeFlow(pending);
  }
  return generation;
};

const html = (body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>IdleBiz</title><body style="background:#12141c;color:#f5f3ea;font-family:ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:18px">${body}</h1><p style="color:#66739f;font-size:13px">You can close this tab and return to IdleBiz.</p></div></body>`;

const connect = (companyId: string, account: ConnectedAccount): void => {
  requireCompany();
  const { accessToken, stripeUserId: accountId, livemode } = account;
  setSecret(STRIPE_TOKEN_KEY, accessToken);
  writeMetricsConfig(companyId, {
    stripeAccount: { accountId, connectedAt: Date.now(), livemode },
  });
  lastError = null;
  notify({ accountId, livemode, state: "connected" });
  onConnected(companyId);
};

const handleCallback = async (flow: PendingFlow, params: URLSearchParams): Promise<boolean> => {
  const callback = parseCallback(params);
  if (pending !== flow) {
    return false;
  }
  if (!callback || callback.nonce !== flow.nonce) {
    fail("Stripe callback rejected (bad nonce).");
    return false;
  }
  const { outcome } = callback;
  if (outcome.kind === "failed") {
    fail(
      outcome.error === "access_denied"
        ? "Stripe connection cancelled."
        : `Stripe: ${outcome.error}`,
    );
    return false;
  }
  const account = await open(flow.ring, outcome.sealed, ConnectedAccountSchema);
  if (pending !== flow) {
    return false;
  }
  if (!account) {
    fail("Stripe callback rejected (envelope not ours).");
    return false;
  }
  closeFlow(flow);
  connect(flow.companyId, account);
  return true;
};

/** Answer the browser after the callback settles; a failure reports and still closes the flow. */
const finishCallback = async (
  flow: PendingFlow,
  params: URLSearchParams,
  current: number,
  res: ServerResponse,
): Promise<void> => {
  let ok = false;
  try {
    ok = await handleCallback(flow, params);
  } catch (error) {
    if (current === generation) {
      fail(errorMessage(error));
    }
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html(ok ? "Stripe connected ✓" : "Stripe connection failed"));
  closeFlow(flow);
};

export const beginConnect = async (companyId: string): Promise<{ started: boolean }> => {
  requireCompany();
  const current = cancelPending();
  lastError = null;
  // Deauthorization revokes the account, including a token a new flow might obtain.
  if (revoking) {
    await revoking;
    if (current !== generation) {
      return { started: false };
    }
  }

  const nonce = randomBytes(16).toString("base64url");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== LOOPBACK_CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const flow = pending;
    if (!flow || flow.server !== server) {
      res.writeHead(410).end();
      return;
    }
    void finishCallback(flow, url.searchParams, current, res);
  });

  try {
    const port = await listenLoopback(server);
    if (current !== generation) {
      server.close();
      return { started: false };
    }
    const ring = await newKeyring();
    if (current !== generation) {
      server.close();
      return { started: false };
    }

    const flow: PendingFlow = {
      companyId,
      nonce,
      ring,
      server,
      timeout: setTimeout(() => {
        if (pending !== flow) {
          return;
        }
        closeFlow(flow);
        fail("Stripe connection timed out — try again.");
      }, FLOW_TIMEOUT_MS),
    };
    pending = flow;
    notify({ state: "connecting" });

    await openExternal(authorizeUrl(WEB_BASE, { key: ring.publicKey, nonce, port }));
    return { started: current === generation };
  } catch (error) {
    server.close();
    if (current !== generation) {
      return { started: false };
    }
    if (pending?.server === server) {
      closeFlow(pending);
    }
    fail(errorMessage(error));
    throw error;
  }
};

// The web route answers 403 when the token no longer reads the account: the
// grant is already gone, so there is nothing left for the founder to remove.
const revoke = async (body: DeauthorizeBody): Promise<Revocation> => {
  try {
    const res = await fetch(`${WEB_BASE}${DEAUTHORIZE_PATH}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(8000),
    });
    return res.ok || res.status === 403
      ? { kind: "revoked" }
      : { kind: "unconfirmed", reason: `HTTP ${res.status}` };
  } catch (error) {
    return { kind: "unconfirmed", reason: errorMessage(error) };
  }
};

/** Clean up local state, then deauthorize on Stripe's side; the founder hears when Stripe did not confirm. */
export const disconnectStripe = async (companyId: string): Promise<void> => {
  requireCompany();
  const current = cancelPending();
  const token = getSecret(STRIPE_TOKEN_KEY);
  const account = readMetricsConfig(companyId)?.stripeAccount;
  // Clear local credentials immediately; new authorization waits for remote revocation below.
  deleteSecret(STRIPE_TOKEN_KEY);
  writeMetricsConfig(companyId, { stripeAccount: undefined });
  lastError = null;
  notify({ state: "disconnected" });
  if (token && account) {
    const body: DeauthorizeBody = { accessToken: token, stripeUserId: account.accountId };
    const revocation = revoke(body);
    revoking = revocation;
    const outcome = await revocation;
    if (revoking === revocation) {
      revoking = null;
    }
    if (outcome.kind === "unconfirmed" && current === generation) {
      fail(
        `Disconnected here, but Stripe may still list IdleBiz (${outcome.reason}) — remove it under Installed apps in your Stripe Dashboard.`,
      );
    }
  }
};
