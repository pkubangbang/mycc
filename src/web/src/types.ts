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
  | 'file-flush';

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
  connectionStatus: ConnectionStatus;
  /** true when a retry prompt is pending (network failure / error recovery) */
  showRetry: boolean;
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
  /** Dark mode toggle (default light). Persisted in localStorage so the
   *  preference survives page reloads. */
  darkMode: boolean;
  /** Files selected for upload but not yet sent. Cleared on send. */
  pendingFiles: FileInfo[];
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