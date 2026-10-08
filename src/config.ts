export type LlmErrorKind =
  | "config"
  | "auth"
  | "timeout"
  | "filtered"
  | "provider"
  | "invalid-response";

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface AppConfig {
  folderId: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

function readNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  isValid: (value: number) => boolean,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || !isValid(value)) {
    throw new LlmError("config", `Некорректное значение переменной ${name}.`);
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const folderId = env.YANDEX_FOLDER_ID?.trim();
  if (!folderId) {
    throw new LlmError("config", "Не задана переменная YANDEX_FOLDER_ID.");
  }

  const timeoutMs = readNumber(
    env,
    "LLM_TIMEOUT_MS",
    3200,
    (value) => Number.isInteger(value) && value > 0 && value <= 4000,
  );
  const maxTokens = readNumber(
    env,
    "LLM_MAX_TOKENS",
    180,
    (value) => Number.isInteger(value) && value > 0,
  );
  const temperature = readNumber(
    env,
    "LLM_TEMPERATURE",
    0.8,
    (value) => value >= 0 && value <= 1,
  );

  const apiKey = env.YANDEX_API_KEY?.trim() || undefined;
  return {
    folderId,
    model: env.YANDEX_GPT_MODEL?.trim() || "yandexgpt-5-lite",
    apiKey,
    timeoutMs,
    maxTokens,
    temperature,
  };
}
