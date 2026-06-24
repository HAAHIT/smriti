import type {
  CaptureEvent,
  CaptureEventMessageAppended,
  ConversationMessageRow,
  ConversationMeta,
  MemoryRecallHit,
  OutlineSegment,
  Platform,
  SearchHit,
} from "@smriti/shared";


export interface HydratedHero {
  hit: SearchHit;
  segments: OutlineSegment[];
  matchedChapterIdx: number;
  matchPct: number;
  why: string;
}

export interface CurrentChat {
  platform: Platform;
  platformConvId: string;
  meta: ConversationMeta | null;     // null = not in our archive yet
  segments: OutlineSegment[];
}

export interface PanelState {
  collapsed: boolean;
  query: string;
  loading: boolean;
  hero: HydratedHero | null;
  others: Array<{ hit: SearchHit; matchPct: number; why: string }>;
  proactiveQuery: string | null;
  msgsIndexed: number | null;
  currentChat: CurrentChat | null;
  memories: MemoryRecallHit[];
  toast: string | null;
}

export interface PanelHandlers {
  onSearch: (query: string) => void;
  onCollapse: () => void;
  onExpand: () => void;
  onInjectMemories: (hits: MemoryRecallHit[]) => void;
  onInjectSingle: (hit: MemoryRecallHit) => void;
  onOpenViewer: (convId: string, msgId: string, query: string) => void;
}