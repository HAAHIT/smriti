// WhatsApp Web parsing — pure string work, no DOM, no browser.
//
// WhatsApp Web is the first human source, and it is unusually generous about
// what it puts in the markup: every message row carries a `data-id` that names
// the chat, the message, whether the user sent it, and (in groups) which
// participant did. That single attribute is the difference between real
// attribution and guessing from bubble alignment.
//
//   1:1     false_919812345678@c.us_3EB0C2F1A2B3
//   1:1 out true_919812345678@c.us_3EB0C2F1A2B3          ← jid is the *other* party
//   group   false_120363019@g.us_3EB0ABC_919812345678@c.us
//                                            ↑ who actually spoke
//
// The other half is `data-pre-plain-text` on the copyable wrapper, which holds
// the rendered timestamp and sender name: "[10:32, 7/31/2026] Alice: ".
//
// The date in it is rendered in the *browser's* locale, so "7/8/2026" is either
// July 8th or August 7th and nothing in the string says which. Guessing wrong
// shifts a message by weeks, and episode segmentation (lib/segment.ts) splits on
// time gaps — so a wrong date silently reshapes the index. Hence `inferDateOrder`
// below: watch the whole chat, wait for a day past the 12th to prove the order,
// and until one appears, refuse to date anything.
//
// Everything here is pure so it can be tested directly (`npm run test:connectors`).

export interface WhatsAppMessageId {
  /** Did the user send this? WhatsApp's own flag, not a guess from styling. */
  fromMe: boolean;
  /** The thread's jid — a contact for a DM, a group jid for a group. */
  chatId: string;
  /** The message's own id, stable across reloads. */
  msgId: string;
  /** In a group, the jid of whoever spoke. Absent in a DM. */
  participant: string | null;
  isGroup: boolean;
}

const JID = /@(c\.us|g\.us|s\.whatsapp\.net|lid|broadcast)$/i;

function isJid(s: string): boolean {
  return JID.test(s);
}

/**
 * Parse a message row's `data-id`.
 *
 * Returns null rather than a partial result: a half-parsed id would attribute a
 * message to the wrong person, which is worse than not attributing it at all.
 */
export function parseDataId(raw: string): WhatsAppMessageId | null {
  const parts = raw.trim().split("_");
  if (parts.length < 3) return null;

  const flag = parts[0].toLowerCase();
  if (flag !== "true" && flag !== "false") return null;

  const chatId = parts[1];
  if (!isJid(chatId)) return null;

  // The message id itself can contain underscores; a trailing participant jid is
  // recognisable by its domain, so peel that off first and keep the rest.
  const tail = parts.slice(2);
  const last = tail[tail.length - 1];
  const participant = tail.length > 1 && isJid(last) ? last : null;
  const msgId = (participant ? tail.slice(0, -1) : tail).join("_");
  if (!msgId) return null;

  return {
    fromMe: flag === "true",
    chatId,
    msgId,
    participant,
    isGroup: /@(g\.us|broadcast)$/i.test(chatId),
  };
}

/**
 * Who spoke, as a source-local id.
 *
 * A DM's incoming message is from the chat itself; a group's is from the
 * participant. An outgoing message is the user's — identified by their own
 * number when the markup happens to include it (groups), and otherwise by the
 * literal `self`, which `lib/people.ts` maps to the shared self person.
 */
export function authorIdOf(id: WhatsAppMessageId): string {
  if (id.fromMe) return id.participant ?? "self";
  if (id.isGroup) return id.participant ?? id.chatId;
  return id.chatId;
}

// ─── data-pre-plain-text ─────────────────────────────────────────────────────

export interface PrePlainText {
  /** As rendered: "10:32" or "10:32 pm". */
  time: string;
  /** As rendered: "7/31/2026", "31/07/2026", "2026-07-31". */
  date: string;
  /** The sender's rendered name, or null — outgoing rows often have none. */
  author: string | null;
}

/** Parse `"[10:32, 7/31/2026] Alice: "`. Returns null if it isn't that shape. */
export function parsePrePlainText(raw: string): PrePlainText | null {
  const m = raw.match(/^\s*\[([^\],]+),\s*([^\]]+)\]\s*(.*?):?\s*$/);
  if (!m) return null;
  const [, time, date, name] = m;
  const author = name.trim();
  return { time: time.trim(), date: date.trim(), author: author || null };
}

// ─── Dates ───────────────────────────────────────────────────────────────────

export type DateOrder = "mdy" | "dmy" | "iso";

const NUMERIC_DATE = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{2,4})$/;

/**
 * Work out whether this browser renders month-first or day-first, from dates the
 * page has actually shown.
 *
 * A component above 12 can only be a day, which settles it. Until one turns up —
 * a chat whose every message falls in the first twelve days of a month — the
 * answer is null and callers must not date anything. Samples that disagree also
 * return null: something is wrong with the assumption, and a wrong date is worse
 * than no date.
 */
export function inferDateOrder(samples: string[]): DateOrder | null {
  let sawMdy = false;
  let sawDmy = false;
  let sawIso = false;

  for (const s of samples) {
    const m = s.trim().match(NUMERIC_DATE);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (m[1].length === 4) {
      sawIso = true;
      continue;
    }
    if (a > 12 && b <= 12) sawDmy = true;
    else if (b > 12 && a <= 12) sawMdy = true;
  }

  if (sawIso && !sawMdy && !sawDmy) return "iso";
  if (sawMdy && sawDmy) return null; // contradictory — trust neither
  if (sawMdy) return "mdy";
  if (sawDmy) return "dmy";
  return null;
}

/**
 * Turn a rendered date and time into an ISO timestamp, in the local zone the
 * page rendered them in. Returns null whenever anything is uncertain — an
 * unparseable time, an impossible day, or an order that was never established.
 */
export function toIsoTimestamp(
  parsed: Pick<PrePlainText, "date" | "time">,
  order: DateOrder | null,
): string | null {
  if (!order) return null;

  const dm = parsed.date.trim().match(NUMERIC_DATE);
  if (!dm) return null;

  let year: number, month: number, day: number;
  if (order === "iso" || dm[1].length === 4) {
    year = Number(dm[1]);
    month = Number(dm[2]);
    day = Number(dm[3]);
  } else {
    year = Number(dm[3]);
    if (order === "mdy") {
      month = Number(dm[1]);
      day = Number(dm[2]);
    } else {
      day = Number(dm[1]);
      month = Number(dm[2]);
    }
  }
  if (year < 100) year += 2000;

  const tm = parsed.time.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/);
  if (!tm) return null;
  let hour = Number(tm[1]);
  const minute = Number(tm[2]);
  const second = Number(tm[3] ?? 0);
  const meridiem = tm[4];
  if (meridiem === "p" && hour < 12) hour += 12;
  if (meridiem === "a" && hour === 12) hour = 0;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const d = new Date(year, month - 1, day, hour, minute, second);
  // Rejects the impossible (31 February rolls forward to March) rather than
  // storing a date the page never showed.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d.toISOString();
}
