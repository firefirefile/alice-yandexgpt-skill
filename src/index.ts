import {
  buildAliceResponse,
  extractCommand,
  getRawSessionState,
  getSessionId,
  isHealthCheck,
  isNewSession,
  normalizeAliceText,
  type AliceResponse,
} from "./alice";
import { appendExchange, fitSessionState, readHistory } from "./conversation";
import { loadConfig } from "./config";
import { SYSTEM_PROMPT } from "./system-prompt";
import { generateCompletion, LlmError, type LlmMessage } from "./yandex-gpt";

export interface FunctionContext {
  token?: {
    access_token: string;
    expires_in: number;
    token_type: string;
  };
}

export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export type GenerateReply = (
  messages: LlmMessage[],
  context: FunctionContext,
) => Promise<string>;

export type Handler = (
  event: unknown,
  context: FunctionContext,
) => Promise<AliceResponse>;

export interface HandlerDependencies {
  generateReply: GenerateReply;
  logger?: Logger;
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

function fallbackFor(error: unknown): string {
  if (!(error instanceof LlmError)) {
    return "Что-то пошло не так. Попробуй ещё раз.";
  }

  switch (error.kind) {
    case "timeout":
      return "Модель сегодня тормозит. Спроси ещё раз.";
    case "filtered":
      return "Модель не смогла ответить на это. Задай другой вопрос.";
    case "auth":
    case "config":
      return "Модель сейчас недоступна из-за настроек. Попробуй позже.";
    case "provider":
    case "invalid-response":
      return "Модель сейчас недоступна. Попробуй ещё раз.";
  }
}

export function createHandler(deps: HandlerDependencies): Handler {
  return async (event, context) => {
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
      return buildAliceResponse("Ну привет. Говори или спрашивай, чего хотел.", currentState);
    }

    if (!command) {
      return buildAliceResponse("Не расслышал. Повтори вопрос ещё раз.", currentState);
    }

    const messages: LlmMessage[] = [
      { role: "system", text: SYSTEM_PROMPT },
      ...history,
      { role: "user", text: command },
    ];
    const startedAt = Date.now();

    try {
      const generated = normalizeAliceText(await deps.generateReply(messages, context));
      const nextState = fitSessionState(appendExchange(history, command, generated));
      deps.logger?.info("YandexGPT request completed", {
        durationMs: Date.now() - startedAt,
        sessionId: getSessionId(event),
      });
      return buildAliceResponse(generated, nextState);
    } catch (error) {
      deps.logger?.error("YandexGPT request failed", {
        kind: error instanceof LlmError ? error.kind : "unexpected",
        status: error instanceof LlmError ? error.status : undefined,
        durationMs: Date.now() - startedAt,
        sessionId: getSessionId(event),
      });
      return buildAliceResponse(fallbackFor(error), currentState);
    }
  };
}

export const handler = createHandler({
  generateReply: async (messages, context) =>
    await generateCompletion(messages, {
      config: loadConfig(process.env),
      iamToken: context.token?.access_token,
    }),
  logger: {
    info: (message, details) => console.info(message, details),
    error: (message, details) => console.error(message, details),
  },
});
