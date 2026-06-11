import { AuthStorage } from "@mariozechner/pi-coding-agent";

// Derive the exact provider/callback types from the SDK so they can't drift.
export type ProviderId = Parameters<AuthStorage["login"]>[0];
export type LoginCallbacks = Parameters<AuthStorage["login"]>[1];

/**
 * Construct an `AuthStorage` rooted at `authPath`. The pi-coding-agent SDK
 * persists OAuth credentials to that file.
 */
export function createAuthStorage(authPath: string): AuthStorage {
  return AuthStorage.create(authPath);
}

export function hasProviderAuth(authStorage: AuthStorage, provider: ProviderId): boolean {
  return authStorage.hasAuth(provider);
}

/**
 * Run the OAuth login flow for `provider`. Resolves once the round-trip
 * completes and credentials are persisted in `authStorage`.
 */
export async function loginWithProvider(
  authStorage: AuthStorage,
  provider: ProviderId,
  callbacks: LoginCallbacks,
): Promise<void> {
  await authStorage.login(provider, callbacks);
}
