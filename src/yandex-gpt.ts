import { LlmError, type AppConfig } from "./config";

export { LlmError } from "./config";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  text: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GenerateCompletionOptions {
  config: AppConfig;
  iamToken?: string;
  fetchImpl?: FetchLike;
}

const COMPLETION_URL =
  "https://ai.api.cloud.yandex.net/foundationModels/v1/completion";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAuthorization(config: AppConfig, iamToken?: string): string {
  const token = iamToken?.trim();
  if (token) {
    return `Bearer ${token}`;
  }
  if (config.apiKey) {
    return `Api-Key ${config.apiKey}`;
  }
  throw new LlmError("auth", "Не настроена авторизация YandexGPT.");
}

function parseCompletion(payload: unknown): string {
  const result = isRecord(payload) ? payload.result : undefined;
  const alternatives = isRecord(result) ? result.alternatives : undefined;
  const alternative = Array.isArray(alternatives) ? alternatives[0] : undefined;

  if (!isRecord(alternative)) {
    throw new LlmError("invalid-response", "YandexGPT вернул ответ без альтернативы.");
  }

  if (alternative.status === "ALTERNATIVE_STATUS_CONTENT_FILTER") {
    throw new LlmError("filtered", "Ответ остановлен фильтром YandexGPT.");
  }

  const message = alternative.message;
  const text = isRecord(message) ? message.text : undefined;
  if (typeof text !== "string" || !text.trim()) {
    throw new LlmError("invalid-response", "YandexGPT вернул пустой ответ.");
  }

  return text.trim();
}

export async function generateCompletion(
  messages: LlmMessage[],
  options: GenerateCompletionOptions,
): Promise<string> {
  const { config } = options;
  const authorization = getAuthorization(config, options.iamToken);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(COMPLETION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
        "x-folder-id": config.folderId,
      },
      body: JSON.stringify({
        modelUri: `gpt://${config.folderId}/${config.model}`,
        completionOptions: {
          stream: false,
          temperature: config.temperature,
          maxTokens: String(config.maxTokens),
        },
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const kind = response.status === 401 || response.status === 403 ? "auth" : "provider";
      throw new LlmError(kind, `YandexGPT ответил с HTTP ${response.status}.`, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LlmError("invalid-response", "YandexGPT вернул невалидный JSON.");
    }
    return parseCompletion(payload);
  } catch (error) {
    if (error instanceof LlmError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new LlmError("timeout", "YandexGPT не ответил вовремя.");
    }
    throw new LlmError("provider", "Не удалось вызвать YandexGPT.");
  } finally {
    clearTimeout(timer);
  }
}
