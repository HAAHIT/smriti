// Pure merge-decision logic for sync — no DB, no I/O, no dependencies.
//
// Split out from sync.ts (which is DB- and model-coupled and so can't be
// imported under tsx) precisely so this — the highest-risk branching in the
// whole feature — can be unit-tested in isolation, the same way extract.ts is.
// sync.ts owns the side effects (the actual INSERT/UPDATE/delete); this owns
// only the decision of which one to take.

export type MergeOutcome = "inserted" | "updated" | "deleted" | "skipped";

export interface MergeLocal {
  norm_text: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MergeRemote {
  id: string;
  updated_at: string;
  deleted_at: string | null;
  norm_text?: string; // present iff deleted_at === null
}

// Decide how to merge one remote memory row into local state. Last-write-wins
// by updated_at, with "delete wins" on conflict (a local tombstone is never
// resurrected) and norm_text-collision skips that self-resolve on a later
// sync.
//
// `collides(normText, exceptId)` reports whether some *active* local memory
// other than exceptId already holds normText — i.e. whether applying this
// remote row would violate the UNIQUE(norm_text) guard.
export function decideMerge(
  remote: MergeRemote,
  local: MergeLocal | null,
  collides: (normText: string, exceptId: string) => boolean,
): MergeOutcome {
  if (!local) {
    if (remote.deleted_at !== null) return "skipped"; // tombstone for an id we never had
    if (collides(remote.norm_text!, remote.id)) return "skipped"; // pre-existing duplicate
    return "inserted";
  }

  // Local delete always wins — no resurrection. The tombstone re-propagates to
  // the peer on this device's next push.
  if (local.deleted_at) return "skipped";

  if (remote.deleted_at !== null) {
    return remote.updated_at > local.updated_at ? "deleted" : "skipped";
  }

  if (remote.updated_at <= local.updated_at) return "skipped"; // local is newer (or equal)

  if (remote.norm_text !== local.norm_text && collides(remote.norm_text!, remote.id)) {
    return "skipped"; // remote's new text collides with a different local memory
  }

  return "updated";
}
