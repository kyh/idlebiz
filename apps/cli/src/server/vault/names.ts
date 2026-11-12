// The names the vault keeps keys under.

export const STRIPE_SECRET_KEY = "STRIPE_SECRET_KEY";
export const VERCEL_TOKEN = "VERCEL_TOKEN";
export const PRINTFUL_TOKEN = "PRINTFUL_TOKEN";
/** Every key IdleBiz itself uses, by name: a misspelt one would read as no key and quietly turn its feature off. */
export const SECRET_NAMES = [STRIPE_SECRET_KEY, VERCEL_TOKEN, PRINTFUL_TOKEN] as const;
type SecretName = (typeof SECRET_NAMES)[number];
/** Where main keeps the values set_env set, one key each. */
export const ENV_PREFIX = "ENV/";
export type EnvSecretName = `${typeof ENV_PREFIX}${string}`;
export type SecretKey = SecretName | EnvSecretName;

/** Whether `name` is one the vault keeps: anything else beside its keys is no key of IdleBiz's. */
export const isSecretKey = (name: string): name is SecretKey =>
  name.startsWith(ENV_PREFIX) || SECRET_NAMES.some((known) => known === name);
