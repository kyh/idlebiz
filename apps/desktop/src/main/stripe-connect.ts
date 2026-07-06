import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { shell } from "electron";
import { getSecret, setSecret, deleteSecret } from "@/main/secrets";
import { readMetricsConfig, writeMetricsConfig } from "@/main/metrics";
import type { StripeStatus } from "@/shared/ipc-registry";

// ---------------------------------------------------------------------------
// Stripe Connect OAuth, desktop side. We open the browser at
// idlebiz.com/api/stripe/authorize with a state of {port, nonce}; the web
// callback exchanges the code (platform secret never leaves Vercel) and
// redirects the read-only connected-account token to our ephemeral loopback
// server. The token then lives in ~/.idlebiz/secrets.json and the metrics
// pulse reads real revenue + customer counts with it.
// ---------------------------------------------------------------------------

const WEB_BASE = process.env["IDLEBIZ_WEB_URL"] ?? "https://idlebiz.com";
const FLOW_TIMEOUT_MS = 5 * 60_000;
const STRIPE_TOKEN_KEY = "STRIPE_CONNECT_TOKEN";

interface PendingFlow {
  server: Server;
  nonce: string;
  timeout: ReturnType<typeof setTimeout>;
}

let pending: PendingFlow | null = null;
let lastError: string | null = null;

type Notify = (status: StripeStatus) => void;
let notify: Notify = () => {};
let onConnected: (companyId: string) => void = () => {};

export function initStripeConnect(hooks: {
  notify: Notify;
  /** Fired after a successful connect so the caller can pulse metrics immediately. */
  onConnected: (companyId: string) => void;
}): void {
  notify = hooks.notify;
  onConnected = hooks.onConnected;
}

export function getStripeStatus(companyId: string): StripeStatus {
  if (pending) return { state: "connecting" };
  if (lastError) return { state: "error", message: lastError };
  const account = readMetricsConfig(companyId)?.stripeAccount;
  if (account && getSecret(STRIPE_TOKEN_KEY)) {
    return { state: "connected", accountId: account.accountId, livemode: account.livemode };
  }
  return { state: "disconnected" };
}

/** The metrics pulse saw a 401 — surface it without deleting the token. */
export function markAuthError(message: string): void {
  if (lastError === message) return;
  lastError = message;
  notify({ state: "error", message });
}

function closePending(): void {
  if (!pending) return;
  clearTimeout(pending.timeout);
  try {
    pending.server.close();
  } catch {
    /* already closed */
  }
  pending = null;
}

function html(body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>IdleBiz</title><body style="background:#12141c;color:#f5f3ea;font-family:ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:18px">${body}</h1><p style="color:#66739f;font-size:13px">You can close this tab and return to IdleBiz.</p></div></body>`;
}

/** Start the loopback server + open the browser at the hosted authorize route. */
export async function beginConnect(companyId: string): Promise<{ started: boolean }> {
  closePending();
  lastError = null;

  const nonce = randomBytes(16).toString("base64url");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/stripe/callback") {
      res.writeHead(404).end();
      return;
    }
    const ok = handleCallback(companyId, url.searchParams);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html(ok ? "Stripe connected ✓" : "Stripe connection failed"));
    closePending();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    server.close();
    throw new Error("loopback server failed to bind");
  }

  pending = {
    server,
    nonce,
    timeout: setTimeout(() => {
      closePending();
      lastError = "Stripe connection timed out — try again.";
      notify({ state: "error", message: lastError });
    }, FLOW_TIMEOUT_MS),
  };
  notify({ state: "connecting" });

  const state = Buffer.from(JSON.stringify({ port: address.port, nonce })).toString("base64url");
  await shell.openExternal(`${WEB_BASE}/api/stripe/authorize?state=${state}`);
  return { started: true };
}

function handleCallback(companyId: string, params: URLSearchParams): boolean {
  if (!pending || params.get("nonce") !== pending.nonce) {
    lastError = "Stripe callback rejected (bad nonce).";
    notify({ state: "error", message: lastError });
    return false;
  }
  const flowError = params.get("error");
  if (flowError) {
    lastError =
      flowError === "access_denied" ? "Stripe connection cancelled." : `Stripe: ${flowError}`;
    notify({ state: "error", message: lastError });
    return false;
  }
  const accessToken = params.get("access_token");
  const accountId = params.get("stripe_user_id");
  if (!accessToken || !accountId) {
    lastError = "Stripe callback missing token.";
    notify({ state: "error", message: lastError });
    return false;
  }
  const livemode = params.get("livemode") === "true";

  setSecret(STRIPE_TOKEN_KEY, accessToken);
  writeMetricsConfig(companyId, {
    stripe: true,
    stripeAccount: { accountId, livemode, connectedAt: Date.now() },
  });
  lastError = null;
  notify({ state: "connected", accountId, livemode });
  onConnected(companyId);
  return true;
}

/** Deauthorize on Stripe's side (best effort) and clean up local state. */
export async function disconnectStripe(companyId: string): Promise<{ ok: boolean }> {
  closePending();
  const token = getSecret(STRIPE_TOKEN_KEY);
  const account = readMetricsConfig(companyId)?.stripeAccount;
  if (token && account) {
    try {
      await fetch(`${WEB_BASE}/api/stripe/deauthorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token, stripeUserId: account.accountId }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      /* best effort — local cleanup still proceeds */
    }
  }
  deleteSecret(STRIPE_TOKEN_KEY);
  writeMetricsConfig(companyId, { stripe: undefined, stripeAccount: undefined });
  lastError = null;
  notify({ state: "disconnected" });
  return { ok: true };
}
