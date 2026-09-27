import { z } from "zod";

/** Names Vercel's function runtime keeps for itself, from its reserved list, and the ones a runtime sets. */
const RESERVED = new Set([
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_SECRET_KEY",
  "HOME",
  "LAMBDA_RUNTIME_DIR",
  "LAMBDA_TASK_ROOT",
  "LANG",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NOW_REGION",
  "PATH",
  "PWD",
  "SHELL",
  "TZ",
  "USER",
]);

/** Vercel's system variables. */
const SYSTEM_PREFIXES = ["VERCEL_", "NOW_"];

/** What a framework builds into the page, where every visitor reads it. */
const PUBLIC_PREFIXES = [
  "NEXT_PUBLIC_",
  "NUXT_PUBLIC_",
  "EXPO_PUBLIC_",
  "PUBLIC_",
  "VITE_",
  "REACT_APP_",
  "VUE_APP_",
  "GATSBY_",
];

const publicPrefixOf = (name: string): string | undefined =>
  PUBLIC_PREFIXES.find((prefix) => name.startsWith(prefix));

/** Whether a framework builds `name`'s value into the page, so shipping it is the point. */
export const isPublicEnvName = (name: string): boolean => publicPrefixOf(name) !== undefined;

/**
 * Values that grant something to whoever reads them, by the shape their issuer gives them: the
 * keys a product is likely to be handed. A public name is for what any visitor may read (a
 * Stripe publishable key, `pk_`), so one of these under it would be served to every visitor.
 * Anthropic's shape comes before OpenAI's, which it also matches. It is a tripwire, not a
 * boundary: a key of any other shape passes.
 */
const ISSUED_SECRETS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\b[rs]k_[0-9A-Za-z_]{8,}/u, what: "a Stripe secret or restricted key" },
  { pattern: /\bwhsec_[0-9A-Za-z]{8,}/u, what: "a Stripe webhook signing secret" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY/u, what: "a private key" },
  { pattern: /\b(?:gh[oprsu]_|github_pat_)[0-9A-Za-z_]{20,}/u, what: "a GitHub token" },
  { pattern: /\bsk-ant-[0-9A-Za-z_-]{16,}/u, what: "an Anthropic API key" },
  { pattern: /\bsk-[0-9A-Za-z_-]{16,}/u, what: "an OpenAI API key" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u, what: "an AWS access key" },
  { pattern: /\bre_[0-9A-Za-z_]{16,}/u, what: "a Resend API key" },
  { pattern: /\bxox[abeoprs]-[0-9A-Za-z-]{10,}/u, what: "a Slack token" },
];

/** Why `value` may not be set under `name`, or null when it may: a public name never takes a secret. */
export const publicValueRefusal = (name: string, value: string): string | null => {
  const prefix = publicPrefixOf(name);
  const secret =
    prefix === undefined ? undefined : ISSUED_SECRETS.find(({ pattern }) => pattern.test(value));
  return prefix === undefined || secret === undefined
    ? null
    : `${name} was not set: that value looks like ${secret.what}, and a ${prefix} name is built into the page, where every visitor reads it. Set it under a server-only name, one without that prefix, which only server code reads as process.env.NAME; a public name is only for what any visitor may see, such as a Stripe publishable key (pk_).`;
};

/** Why `name` cannot be set on a product's project, or null when it can. */
const refusalOf = (name: string): string | null =>
  RESERVED.has(name) || SYSTEM_PREFIXES.some((prefix) => name.startsWith(prefix))
    ? `${name} is Vercel's or the runtime's own: pick a name of the product's.`
    : null;

/** An environment variable name a teammate may set: POSIX's portable form, none Vercel keeps. */
export const EnvNameSchema = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]*$/u,
    "name must be an environment variable name: uppercase letters, digits and underscores, not starting with a digit",
  )
  .max(256)
  .superRefine((name, ctx) => {
    const refused = refusalOf(name);
    if (refused !== null) {
      ctx.addIssue({ code: "custom", message: refused });
    }
  });
