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

/** Why `name` cannot be a secret set on a product's project, or null when it can. */
const refusalOf = (name: string): string | null => {
  if (RESERVED.has(name) || SYSTEM_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return `${name} is Vercel's or the runtime's own: pick a name of the product's.`;
  }
  const exposed = PUBLIC_PREFIXES.find((prefix) => name.startsWith(prefix));
  return exposed === undefined
    ? null
    : `a ${exposed} name is built into the page, where every visitor reads it: a value the browser may see belongs in the source, and a secret takes a name without that prefix.`;
};

/** An environment variable name a teammate may set: POSIX's portable form, none Vercel keeps, none the page shows. */
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
