export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ConversationState {
  v: 1;
  history: ChatMessage[];
}

const DEFAULT_MAX_STATE_BYTES = 900;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { role, text } = value;
  if (
    (role !== "user" && role !== "assistant") ||
    typeof text !== "string" ||
    !text.trim()
  ) {
    return undefined;
  }

  return { role, text: text.trim() };
}

export function readHistory(rawState: unknown, isNew: boolean): ChatMessage[] {
  if (isNew || !isRecord(rawState) || rawState.v !== 1 || !Array.isArray(rawState.history)) {
    return [];
  }

  const messages = rawState.history.map(parseMessage);
  if (messages.some((message) => message === undefined) || messages.length % 2 !== 0) {
    return [];
  }

  const history = messages as ChatMessage[];
  for (let index = 0; index < history.length; index += 1) {
    const expectedRole = index % 2 === 0 ? "user" : "assistant";
    if (history[index]?.role !== expectedRole) {
      return [];
    }
  }

  return history;
}

export function appendExchange(
  history: ChatMessage[],
  userText: string,
  assistantText: string,
): ChatMessage[] {
  return [
    ...history,
    { role: "user", text: userText.trim() },
    { role: "assistant", text: assistantText.trim() },
  ];
}

export function sessionStateBytes(state: ConversationState): number {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

export function fitSessionState(
  history: ChatMessage[],
  maxBytes = DEFAULT_MAX_STATE_BYTES,
): ConversationState {
  const retained = [...history];
  let state: ConversationState = { v: 1, history: retained };

  while (retained.length > 0 && sessionStateBytes(state) > maxBytes) {
    retained.splice(0, 2);
    state = { v: 1, history: retained };
  }

  return state;
}
