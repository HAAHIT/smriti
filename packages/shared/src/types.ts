export type Platform = "claude" | "chatgpt" | "gemini" | "claude_code";

export type Role = "user" | "assistant" | "system" | "tool";

export interface CaptureEventConversationSeen {
  kind: "conversation_seen";
  platform: Platform;
  platform_conv_id: string;
  title?: string;
  url: string;
  observed_at: string;
}

export interface CaptureEventMessageAppended {
  kind: "message_appended";
  platform: Platform;
  platform_conv_id: string;
  platform_msg_id?: string;
  role: Role;
  content_text: string;
  content_html?: string;
  model?: string;
  created_at: string;
  position: number;
}

export interface CaptureEventConversationUpdated {
  kind: "conversation_updated";
  platform: Platform;
  platform_conv_id: string;
  title?: string;
  archived?: boolean;
}

export type CaptureEvent =
  | CaptureEventConversationSeen
  | CaptureEventMessageAppended
  | CaptureEventConversationUpdated;

export interface Conversation {
  id: string;
  platform: Platform;
  platform_conv_id: string;
  title: string | null;
  model: string | null;
  url: string | null;
  started_at: string;
  last_message_at: string;
  archived: number;
  ingested_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  platform_msg_id: string | null;
  role: Role;
  content_text: string;
  content_html: string | null;
  model: string | null;
  created_at: string;
  position: number;
  token_count: number | null;
  content_hash: string;
}
