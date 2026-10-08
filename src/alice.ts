export interface AliceRequest {
  request?: {
    type?: unknown;
    command?: unknown;
    original_utterance?: unknown;
  };
  session?: {
    new?: unknown;
    session_id?: unknown;
  };
  state?: {
    session?: unknown;
  };
  version?: unknown;
}

export interface AliceResponse {
  response: {
    text: string;
    end_session: false;
  };
  session_state?: unknown;
  version: "1.0";
}

const EMPTY_RESPONSE = "Не получилось сформировать ответ. Попробуй ещё раз.";
const MAX_RESPONSE_LENGTH = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

export function extractCommand(event: unknown): string {
  const command = nestedRecord(event, "request")?.command;
  return typeof command === "string" ? command.trim() : "";
}

export function isHealthCheck(event: unknown): boolean {
  const utterance = nestedRecord(event, "request")?.original_utterance;
  return typeof utterance === "string" && utterance.trim().toLowerCase() === "ping";
}

export function isNewSession(event: unknown): boolean {
  return nestedRecord(event, "session")?.new === true;
}

export function getSessionId(event: unknown): string | undefined {
  const sessionId = nestedRecord(event, "session")?.session_id;
  return typeof sessionId === "string" ? sessionId : undefined;
}

export function getRawSessionState(event: unknown): unknown {
  return nestedRecord(event, "state")?.session;
}

export function normalizeAliceText(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return EMPTY_RESPONSE;
  }

  if (normalized.length <= MAX_RESPONSE_LENGTH) {
    return normalized;
  }

  const candidate = normalized.slice(0, MAX_RESPONSE_LENGTH);
  const sentenceBoundary = Math.max(
    candidate.lastIndexOf("."),
    candidate.lastIndexOf("!"),
    candidate.lastIndexOf("?"),
  );
  if (sentenceBoundary >= Math.floor(MAX_RESPONSE_LENGTH / 2)) {
    return candidate.slice(0, sentenceBoundary + 1).trimEnd();
  }

  const wordBoundary = candidate.lastIndexOf(" ");
  return (wordBoundary > 0 ? candidate.slice(0, wordBoundary) : candidate).trimEnd();
}

export function buildAliceResponse(
  text: string,
  sessionState?: unknown,
): AliceResponse {
  const response: AliceResponse = {
    response: {
      text: normalizeAliceText(text),
      end_session: false,
    },
    version: "1.0",
  };

  if (sessionState !== undefined) {
    response.session_state = sessionState;
  }

  return response;
}
