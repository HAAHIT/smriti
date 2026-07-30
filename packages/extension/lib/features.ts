// Build-time feature flags.
//
// A flag here means "this subsystem's code is intentionally still in the tree,
// but its UI is withheld". That is different from dead code: the engine, its
// migrations and its tests stay, so nothing rots and nothing has to be
// resurrected from git history later.
//
// SYNC and VAULT are frozen for the per-app-memory-layers refactor. Both are
// feature-complete in the engine but not runnable end to end — sync needs a
// deployed relay to replace the `YOUR-SUBDOMAIN.workers.dev` placeholder, and
// vault needs a real OAuth client ID plus `googleapis.com` in the `connect-src`
// CSP (see docs/VAULT_SYNC.md). Shipping a Settings toggle for either would put
// a half-working feature in front of a user. Flip these back to `true` in the
// same commit that fixes the underlying blocker.
//
// Both engines are already dormant at runtime when their config row says
// disabled (which is the default), so hiding the UI is all that is required —
// no scheduler is left ticking behind the flag.

export const FEATURES = {
  /** Settings → Sync (E2E-encrypted memory sync via packages/sync-relay). */
  SYNC: false,
  /** Settings → Vault (conversations → OKF markdown → Google Drive). */
  VAULT: false,
} as const;
