// Identity normalisation — pure, DB-free, and deliberately conservative.
//
// A human source names its participants however the page happens to render
// them: "919812345678@c.us" in a WhatsApp data-id, "+91 98123 45678" in a
// contact card, "@alice" in a handle. All three have to land on one stable key
// or the same person becomes several rows in `people` and their memory splits.
//
// The rule everywhere below is: **normalise formatting, never guess semantics.**
// A national-format number ("09812345678") is not converted to international,
// because doing so means inventing a country code, and inventing one merges two
// different humans into a single identity — an error the user cannot see and
// cannot undo. Two rows for one person is a visible, fixable annoyance; one row
// for two people leaks one person's chat history into the other's memory. So
// when in doubt this module keeps things apart.
//
// Kept free of DB and browser imports so it can be tested directly
// (`npm run test:people`), the same split as lib/ingest-identity.ts.

import type { CaptureAuthor, CaptureSpace, SourceId } from "@smriti/shared";

/** Chat-app address domains. WhatsApp jids look like `<number>@c.us`. */
const JID_DOMAINS = [
  "@c.us",
  "@s.whatsapp.net",
  "@g.us",
  "@lid",
  "@broadcast",
];

/**
 * A bare digit string this long is an international number missing its `+`.
 * WhatsApp jids are always international and never carry the plus, so they land
 * here. Ten digits or fewer is a national format and is left alone — see the
 * header.
 */
const INTERNATIONAL_MIN_DIGITS = 11;

/** Does this id address a group rather than a single person? */
export function isGroupId(raw: string): boolean {
  return /@g\.us$/i.test(raw.trim()) || /@broadcast$/i.test(raw.trim());
}

/** Strip a jid domain, returning the local part and whether one was present. */
function splitJid(raw: string): { local: string; wasJid: boolean } {
  const lower = raw.trim().toLowerCase();
  for (const d of JID_DOMAINS) {
    if (lower.endsWith(d)) {
      // A group jid's local part can carry a `-` (legacy `<creator>-<ts>` form);
      // keep it verbatim, it is an opaque key rather than a phone number.
      return { local: lower.slice(0, -d.length), wasJid: true };
    }
  }
  return { local: lower, wasJid: false };
}

/** Only digits, `+`, and the punctuation people write phone numbers with. */
function looksLikePhone(s: string): boolean {
  return /^\+?[\d\s().\-‐-―]+$/.test(s) && /\d/.test(s);
}

/**
 * The stable, source-local key for a participant or a thread.
 *
 * Idempotent: `normalizeExternalId(normalizeExternalId(x)) === normalizeExternalId(x)`,
 * which matters because normalised ids are written to `person_identities` and
 * then read back and re-normalised on the next capture.
 */
export function normalizeExternalId(raw: string): string {
  const { local, wasJid } = splitJid(raw);
  if (!local) return "";

  // Group / broadcast ids are opaque — no phone semantics to apply.
  if (isGroupId(raw)) return local;

  if (looksLikePhone(local)) {
    const digits = local.replace(/\D/g, "");
    if (!digits) return "";
    // A leading zero is a national trunk prefix, never part of an international
    // number — "09812345678" is a local way of writing something whose country
    // code we do not know, so it stays as written.
    const international =
      wasJid ||
      local.trim().startsWith("+") ||
      (digits.length >= INTERNATIONAL_MIN_DIGITS && !digits.startsWith("0"));
    return international ? `+${digits}` : digits;
  }

  // A handle: strip a leading @, collapse internal whitespace.
  return local.replace(/^@+/, "").replace(/\s+/g, " ").trim();
}

/**
 * Deterministic person id, matching migration 006's convention of readable
 * string ids (`person:self`, `person:bot:claude`) rather than UUIDs.
 *
 * This is only the *initial* id for an identity. `person_identities` stays the
 * mapping layer, so merging two identities later means repointing that row —
 * the person id it resolves to need not match this shape forever.
 */
export function personIdFor(source: SourceId, externalId: string): string {
  return `person:${source}:${normalizeExternalId(externalId)}`;
}

/** The user themselves — one row, shared by every source. From migration 006. */
export const SELF_PERSON_ID = "person:self";

/** An AI source's assistant. From migration 006. */
export function botPersonId(source: SourceId): string {
  return `person:bot:${source}`;
}

/** The `space_key` written to `spaces`, normalised the same way people are. */
export function spaceKeyFor(space: CaptureSpace): string {
  if (space.kind === "app") return "app";
  return normalizeExternalId(space.space_key);
}

/**
 * Deterministic space id. The app form is `space:<source>` exactly as migration
 * 006 backfilled it, so an existing archive's spaces are found rather than
 * duplicated.
 */
export function spaceIdFor(source: SourceId, space: CaptureSpace): string {
  const key = spaceKeyFor(space);
  return space.kind === "app" ? `space:${source}` : `space:${source}:${key}`;
}

/** The app-level space every AI source uses. */
export const APP_SPACE: CaptureSpace = { space_key: "app", kind: "app" };

const MAX_DISPLAY_NAME = 80;

/**
 * A display name safe to store: trimmed, single-spaced, length-capped, and
 * never empty — a WhatsApp contact with no saved name renders as the number, so
 * falling back to the normalised id is the honest answer rather than "Unknown".
 */
export function displayNameFor(author: CaptureAuthor): string {
  const raw = (author.display_name ?? "").replace(/\s+/g, " ").trim();
  const name = raw || normalizeExternalId(author.external_id);
  return name.slice(0, MAX_DISPLAY_NAME);
}

/**
 * Is this author the user? Connectors that can tell (WhatsApp's data-id carries
 * a `fromMe` flag) set it explicitly; everything else is someone else.
 */
export function isSelf(author: CaptureAuthor): boolean {
  return author.is_self === true;
}
