import {
  buildAliceResponse,
  extractCommand,
  getRawSessionState,
  isHealthCheck,
  isNewSession,
  normalizeAliceText,
  type AliceResponse,
} from "./alice";
import { appendExchange, fitSessionState, readHistory } from "./conversation";

export const DEFAULT_MOCK_RESPONSE =
  "Это тестовый ответ навыка. YandexGPT и другие внешние модели не вызываются.";

export type Handler = (event: unknown, context?: unknown) => Promise<AliceResponse>;

export interface HandlerOptions {
  responseText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAliceEvent(event: unknown): boolean {
  return (
    isRecord(event) &&
    isRecord(event.request) &&
    isRecord(event.session) &&
    event.version === "1.0"
  );
}

function resolveMockResponse(value?: string): string {
  return normalizeAliceText(value?.trim() || DEFAULT_MOCK_RESPONSE);
}

export function createHandler(options: HandlerOptions = {}): Handler {
  const mockResponse = resolveMockResponse(options.responseText);

  return async (event) => {
    if (isHealthCheck(event)) {
      return buildAliceResponse("pong");
    }

    if (!isAliceEvent(event)) {
      return buildAliceResponse("Не получилось разобрать запрос. Повтори ещё раз.");
    }

    const newSession = isNewSession(event);
    const history = readHistory(getRawSessionState(event), newSession);
    const currentState = fitSessionState(history);
    const command = extractCommand(event);

    if (!command && newSession) {
      return buildAliceResponse("Ну привет. Скажи что-нибудь для проверки.", currentState);
    }

    if (!command) {
      return buildAliceResponse("Не расслышал. Повтори ещё раз.", currentState);
    }

    const nextState = fitSessionState(appendExchange(history, command, mockResponse));
    return buildAliceResponse(mockResponse, nextState);
  };
}

export const handler = createHandler({
  responseText: process.env.MOCK_RESPONSE,
});
