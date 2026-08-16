/**
 * types.ts - Shared type definitions for the mycc web chat UI
 */

export type MessageType =
  | 'user'
  | 'log'
  | 'warn'
  | 'error'
  | 'result'
  | 'prompt'
  | 'system'
  | 'card'
  | 'steer-echo'
  | 'steer-flush'
  | 'file-upload'
  | 'file-flush'
  | 'auto'
  | 'running';

export interface ChatMessage {
  type: MessageType;
  content: string;
  /** Unique id for stable v-for keys (incrementing counter). Optional for
   *  history-loaded messages that predate the id scheme. */
  id?: number;
  timestamp?: number;
  /** tool/module tag (e.g. 'assistant', 'brief', 'question', 'bash').
   *  Shown as [HH:MM:SS] [label] header above the content, mirroring the
   *  terminal brief format. Absent for raw verbose logs. */
  label?: string;
  /** Tool intent/description (e.g. "RUN USER TO list project files" for bash).
   *  When present, rendered as an outlined box above the bubble content. */
  detail?: string;
  /** Card payload — present when type === 'card'. Drives CardItem.vue. */
  card?: CardPayload;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

export interface ChatState {
  messages: ChatMessage[];
  inputText: string;
  /** true when a prompt is pending user input (input box enabled) */
  isWaiting: boolean;
  /** true while the agent is actively working (between submit and next prompt) */
  isRunning: boolean;
  /** true while the lead is in autonomous (auto) mode. The PROMPT stage is
   *  replaced by a WAIT stage that blocks for mail/teammate/steering events
   *  instead of prompting, so the chat input box stays ENABLED for steering
   *  even when neither isWaiting nor isRunning is true (the steady WAIT
   *  state broadcasts neither). Input in auto mode is always a steering
   *  note (queued, consumed at the next COLLECT) — never a fresh prompt.
   *  Set by a backend 'auto' broadcast on every flag flip + on WS connect. */
  isAutoMode: boolean;
  connectionStatus: ConnectionStatus;
  /** true when a retry prompt is pending (network failure / error recovery) */
  showRetry: boolean;
  /** true when an interactive card (ask()) is pending a response. While true,
   *  the main chat input box is disabled so the user replies on the card
   *  itself — otherwise dialog input would be silently dropped (the agent is
   *  blocked in TOOL state awaiting the card resolver, not PROMPT state). */
  hasPendingCard: boolean;
  /** 详细日志 toggle (default off). When off, only user-facing lines are shown
   *  (user, result/assistant, brief, question, prompt). When on, all logs
   *  (verbose tool output, warnings, errors) are shown too. */
  verboseLogs: boolean;
  /** Transient error string shown in the StatusBar when a send fails (e.g.
   *  input submitted while the socket isn't OPEN). Cleared on next success. */
  connectionError?: string;
  /** Queued steering notes (mid-task direction the user sent while the LLM
   *  was working). Displayed as chips in the SteeringBuffer bar; cleared when
   *  the backend broadcasts 'steer-flush' (notes consumed at COLLECT/PROMPT). */
  steeringBuffer: string[];
  /** Steering notes captured from 'steer-flush' for user review at the next
   *  PROMPT. Populated when the backend flushes the steering queue (at
   *  COLLECT), surfacing the notes the backend already consumed so the user
   *  can ALSO decide to send them as a fresh query or discard them — rather
   *  than having them silently injected as REMINDER notes only. Surfaced as
   *  a temporary "继续…" card inside the chat log (SteeringReviewCard) when
   *  isWaiting is true. Cleared when the agent leaves PROMPT (isWaiting
   *  flips false), or when the user sends them as a query / discards them.
   *  Not captured in auto mode (the agent processes steering automatically,
   *  no PROMPT to review at). Not persisted to the message list — purely
   *  transient, never survives a refresh. */
  pendingSteeringReview: string[];
  /** Dark mode toggle (default light). Persisted in localStorage so the
   *  preference survives page reloads. */
  darkMode: boolean;
  /** Files selected for upload but not yet sent. Cleared on send. */
  pendingFiles: FileInfo[];
  /** Teammate messages routed by the @-prefix label convention — any
   *  message whose `label` starts with `@` is a teammate message and goes
   *  here instead of `messages`. Grouped by teammate name in the accordion
   *  UI (TeammateCard / TeammateDrawer). Survives page refresh / WS
   *  reconnect via the /history replay (approximate persistence — lost on
   *  serve stop/restart, same as the main messageLog). */
  teammateMessages: ChatMessage[];
}

export interface FileInfo {
  filename: string;
  data: string;
  mimeType: string;
}

/** A single option in a choice/confirm card. */
export interface CardOption {
  label: string;
  value: string;
  /** True if this option is the default (uppercase letter in the bracket
   *  suffix, e.g. `[y/N]` → the 'N' option is default). Rendered with an
   *  accent border + bold font in CardItem.vue so the user sees the
   *  safe/expected choice at a glance. */
  isDefault?: boolean;
}

/** Payload for an interactive card (type === 'card'). Rendered by CardItem.vue. */
export interface CardPayload {
  cardId: string;
  query: string;
  kind: 'input' | 'confirm' | 'choice';
  options?: CardOption[];
  initialContent?: string;
  placeholder?: string;
}