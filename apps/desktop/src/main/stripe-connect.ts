import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { shell } from "electron";
import {
  ConnectedAccountSchema,
  DEAUTHORIZE_PATH,
  LOOPBACK_CALLBACK_PATH,
  authorizeUrl,
  parseCallback,
  type ConnectedAccount,
  type DeauthorizeBody,
} from "@repo/stripe-connect-protocol/protocol";
import { newKeyring, open, type Keyring } from "@repo/stripe-connect-protocol/seal";
import { listenLoopback } from "@/main/lib/http";
import { getSecret, setSecret, deleteSecret } from "@/main/secrets";
import { readMetricsConfig, writeMetricsConfig } from "@/main/metrics";
import type { StripeStatus } from "@/shared/ipc-registry";

// ---------------------------------------------------------------------------
// Stripe Connect OAuth, desktop side. We open the browser at the site's
// authorize route with a state naming our ephemeral loopback port; the site's
// callback exchanges the code (platform secret never leaves Vercel) and
// redirects the read-only connected-account token to us. The token then lives
// in ~/.idlebiz/secrets.json and the metrics pulse reads real revenue +
// customer counts with it. The handshake's shapes: @repo/stripe-connect-protocol.
// ---------------------------------------------------------------------------

const WEB_BASE = process.env["IDLEBIZ_WEB_URL"] ?? "https://idlebiz.com";
const FLOW_TIMEOUT_MS = 5 * 60_000;
const STRIPE_TOKEN_KEY = "STRIPE_CONNECT_TOKEN";

interface PendingFlow {
  server: Server;
  nonce: string;
  /** This flow's key pair; the private half dies with the flow. */
  ring: Keyring;
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

/** The flow stopped: remember why (the status query reports it) and tell the window. */
function fail(message: string): void {
  lastError = message;
  notify({ state: "error", message });
}

/** The metrics pulse saw a 401 — surface it without deleting the token. */
export function markAuthError(message: string): void {
  if (lastError !== message) fail(message);
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
    if (url.pathname !== LOOPBACK_CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    void handleCallback(companyId, url.searchParams).then((ok) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html(ok ? "Stripe connected ✓" : "Stripe connection failed"));
      closePending();
      return null;
    });
  });

  const port = await listenLoopback(server);
  const ring = await newKeyring();

  pending = {
    server,
    nonce,
    ring,
    timeout: setTimeout(() => {
      closePending();
      fail("Stripe connection timed out — try again.");
    }, FLOW_TIMEOUT_MS),
  };
  notify({ state: "connecting" });

  await shell.openExternal(authorizeUrl(WEB_BASE, { port, nonce, key: ring.publicKey }));
  return { started: true };
}

async function handleCallback(companyId: string, params: URLSearchParams): Promise<boolean> {
  const callback = parseCallback(params);
  if (!pending || !callback || callback.nonce !== pending.nonce) {
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
  const account = await open(pending.ring, outcome.sealed, ConnectedAccountSchema);
  if (!account) {
    fail("Stripe callback rejected (envelope not ours).");
    return false;
  }
  connect(companyId, account);
  return true;
}

function connect(companyId: string, account: ConnectedAccount): void {
  const { accessToken, stripeUserId: accountId, livemode } = account;
  setSecret(STRIPE_TOKEN_KEY, accessToken);
  writeMetricsConfig(companyId, {
    stripe: true,
    stripeAccount: { accountId, livemode, connectedAt: Date.now() },
  });
  lastError = null;
  notify({ state: "connected", accountId, livemode });
  onConnected(companyId);
}

/** Deauthorize on Stripe's side (best effort) and clean up local state. */
export async function disconnectStripe(companyId: string): Promise<{ ok: boolean }> {
  closePending();
  const token = getSecret(STRIPE_TOKEN_KEY);
  const account = readMetricsConfig(companyId)?.stripeAccount;
  if (token && account) {
    const body: DeauthorizeBody = { accessToken: token, stripeUserId: account.accountId };
    try {
      await fetch(`${WEB_BASE}${DEAUTHORIZE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
