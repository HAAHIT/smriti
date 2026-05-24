// Claude.ai backfill adapter.
//
// Endpoints (verified May 2026; expect drift):
//   GET https://claude.ai/api/organizations
//     → [{ uuid, name, ... }]
//   GET https://claude.ai/api/organizations/{orgId}/chat_conversations
//        ?limit=100&offset=N&archived=false
//     → [{ uuid, name, created_at, updated_at, ... }, ...]
//   GET https://claude.ai/api/organizations/{orgId}/chat_conversations/{convId}
//        ?tree=True
//     → { uuid, name, chat_messages: [{ uuid, text, sender, created_at, ...}] }
//
// Parsing is defensive: we accept several shape variants for messages.

import type { CaptureEvent } from "@recall/shared";
import { proxyFetch } from "../nm.js";

const BASE = "https://claude.ai";

interface OrgRow {
  uuid: string;
  name?: string;
}

interface ConvRow {
  uuid: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
}

interface ChatMessage {
  uuid?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }> | string;
  sender?: string;
  role?: string;
  created_at?: string;
  model?: string;
}

interface ConvDetail {
  uuid: string;
  name?: string;
  chat_messages?: ChatMessage[];
  messages?: ChatMessage[];
  model?: string;
}

export async function listOrganizations(): Promise<OrgRow[]> {
  const res = await proxyFetch(`${BASE}/api/organizations`);
  if (res.status !== 200) throw new Error(`organizations: status ${res.status}`);
  const arr = JSON.parse(res.body) as OrgRow[];
  if (!Array.isArray(arr)) throw new Error("organizations: not array");
  return arr;
}

export async function listConversations(
  orgId: string,
  offset: number,
  limit = 100,
  archived = false,
): Promise<ConvRow[]> {
  const url = `${BASE}/api/organizations/${orgId}/chat_conversations?limit=${limit}&offset=${offset}&archived=${archived}`;
  const res = await proxyFetch(url);
  if (res.status !== 200) throw new Error(`conversations: status ${res.status}`);
  const arr = JSON.parse(res.body) as ConvRow[];
  if (!Array.isArray(arr)) throw new Error("conversations: not array");
  return arr;
}

export async function fetchConversation(
  orgId: string,
  convId: string,
): Promise<ConvDetail | null> {
  const url = `${BASE}/api/organizations/${orgId}/chat_conversations/${convId}?tree=True`;
  const res = await proxyFetch(url);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`conversation ${convId}: status ${res.status}`);
  return JSON.parse(res.body) as ConvDetail;
}

export function convToEvents(
  detail: ConvDetail,
  fallbackUuid: string,
  url: string,
): CaptureEvent[] {
  const convId = detail.uuid ?? fallbackUuid;
  const messages = detail.chat_messages ?? detail.messages ?? [];
  const observedAt = new Date().toISOString();
  const events: CaptureEvent[] = [
    {
      kind: "conversation_seen",
      platform: "claude",
      platform_conv_id: convId,
      title: detail.name ?? undefined,
      url,
      observed_at: observedAt,
    },
  ];

  for (const m of messages) {
    const text = extractText(m);
    if (!text) continue;
    const role = normalizeRole(m.sender ?? m.role);
    if (!role) continue;
    const ts = m.created_at ?? observedAt;
    events.push({
      kind: "message_appended",
      platform: "claude",
      platform_conv_id: convId,
      platform_msg_id: m.uuid,
      role,
      content_text: text,
      model: m.model ?? detail.model,
      created_at: ts,
      position: Date.parse(ts) || Date.now(),
    });
  }
  return events;
}

function extractText(m: ChatMessage): string | null {
  if (typeof m.text === "string" && m.text.length > 0) return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const block of m.content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return null;
}

function normalizeRole(s: string | undefined): "user" | "assistant" | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  if (lc === "user" || lc === "human") return "user";
  if (lc === "assistant" || lc === "ai" || lc === "claude") return "assistant";
  return null;
}
