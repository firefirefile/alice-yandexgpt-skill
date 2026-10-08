import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config";
import {
  generateCompletion,
  LlmError,
  type FetchLike,
  type LlmMessage,
} from "../src/yandex-gpt";

const messages: LlmMessage[] = [
  { role: "system", text: "Отвечай кратко" },
  { role: "user", text: "Привет" },
];

function jsonFetch(body: unknown, status = 200, capture?: (url: string, init: RequestInit) => void): FetchLike {
  return async (input, init = {}) => {
    capture?.(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

test("loads documented defaults", () => {
  assert.deepEqual(loadConfig({ YANDEX_FOLDER_ID: "folder-id" }), {
    folderId: "folder-id",
    model: "yandexgpt-5-lite",
    apiKey: undefined,
    timeoutMs: 3200,
    maxTokens: 180,
    temperature: 0.8,
  });
});

test("rejects a missing folder id", () => {
  assert.throws(() => loadConfig({}), (error: unknown) => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.kind, "config");
    return true;
  });
});

test("rejects invalid numeric configuration", () => {
  assert.throws(
    () => loadConfig({ YANDEX_FOLDER_ID: "folder-id", LLM_TEMPERATURE: "2" }),
    (error: unknown) => error instanceof LlmError && error.kind === "config",
  );
  assert.throws(
    () => loadConfig({ YANDEX_FOLDER_ID: "folder-id", LLM_TIMEOUT_MS: "zero" }),
    (error: unknown) => error instanceof LlmError && error.kind === "config",
  );
});

test("sends the documented YandexGPT completion request", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit = {};
  const fetchImpl = jsonFetch(
    {
      result: {
        alternatives: [
          {
            message: { role: "assistant", text: " Привет в ответ " },
            status: "ALTERNATIVE_STATUS_FINAL",
          },
        ],
      },
    },
    200,
    (url, init) => {
      capturedUrl = url;
      capturedInit = init;
    },
  );

  const result = await generateCompletion(messages, {
    config: loadConfig({ YANDEX_FOLDER_ID: "folder-id" }),
    iamToken: "iam-token",
    fetchImpl,
  });

  const headers = capturedInit.headers as Record<string, string>;
  const body = JSON.parse(String(capturedInit.body)) as Record<string, unknown>;
  assert.equal(result, "Привет в ответ");
  assert.equal(capturedUrl, "https://ai.api.cloud.yandex.net/foundationModels/v1/completion");
  assert.equal(capturedInit.method, "POST");
  assert.equal(headers.Authorization, "Bearer iam-token");
  assert.equal(headers["x-folder-id"], "folder-id");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(body.modelUri, "gpt://folder-id/yandexgpt-5-lite");
  assert.deepEqual(body.completionOptions, {
    stream: false,
    temperature: 0.8,
    maxTokens: "180",
  });
  assert.deepEqual(body.messages, messages);
});

test("prefers IAM bearer auth", async () => {
  let authorization = "";
  const fetchImpl = jsonFetch(
    {
      result: {
        alternatives: [
          { message: { role: "assistant", text: "ok" }, status: "ALTERNATIVE_STATUS_FINAL" },
        ],
      },
    },
    200,
    (_url, init) => {
      authorization = (init.headers as Record<string, string>).Authorization;
    },
  );

  await generateCompletion(messages, {
    config: loadConfig({ YANDEX_FOLDER_ID: "folder-id", YANDEX_API_KEY: "api-secret" }),
    iamToken: "iam-secret",
    fetchImpl,
  });

  assert.equal(authorization, "Bearer iam-secret");
});

test("falls back to Api-Key auth", async () => {
  let authorization = "";
  const fetchImpl = jsonFetch(
    {
      result: {
        alternatives: [
          { message: { role: "assistant", text: "ok" }, status: "ALTERNATIVE_STATUS_FINAL" },
        ],
      },
    },
    200,
    (_url, init) => {
      authorization = (init.headers as Record<string, string>).Authorization;
    },
  );

  await generateCompletion(messages, {
    config: loadConfig({ YANDEX_FOLDER_ID: "folder-id", YANDEX_API_KEY: "api-secret" }),
    fetchImpl,
  });

  assert.equal(authorization, "Api-Key api-secret");
});

test("rejects missing auth without exposing secrets", async () => {
  await assert.rejects(
    generateCompletion(messages, {
      config: loadConfig({ YANDEX_FOLDER_ID: "folder-id" }),
      fetchImpl: jsonFetch({}),
    }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, "auth");
      assert.doesNotMatch(String(error), /iam-secret|api-secret/u);
      return true;
    },
  );
});

test("classifies content filtering", async () => {
  await assert.rejects(
    generateCompletion(messages, {
      config: loadConfig({ YANDEX_FOLDER_ID: "folder-id" }),
      iamToken: "iam-token",
      fetchImpl: jsonFetch({
        result: {
          alternatives: [
            {
              message: { role: "assistant", text: "" },
              status: "ALTERNATIVE_STATUS_CONTENT_FILTER",
            },
          ],
        },
      }),
    }),
    (error: unknown) => error instanceof LlmError && error.kind === "filtered",
  );
});

test("classifies non-2xx provider responses without exposing credentials", async () => {
  await assert.rejects(
    generateCompletion(messages, {
      config: loadConfig({ YANDEX_FOLDER_ID: "folder-id", YANDEX_API_KEY: "api-secret" }),
      iamToken: "iam-secret",
      fetchImpl: jsonFetch({ message: "iam-secret api-secret" }, 401),
    }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, "auth");
      assert.equal(error.status, 401);
      assert.doesNotMatch(String(error), /iam-secret|api-secret/u);
      return true;
    },
  );
});

test("rejects an empty alternative", async () => {
  await assert.rejects(
    generateCompletion(messages, {
      config: loadConfig({ YANDEX_FOLDER_ID: "folder-id" }),
      iamToken: "iam-token",
      fetchImpl: jsonFetch({ result: { alternatives: [] } }),
    }),
    (error: unknown) => error instanceof LlmError && error.kind === "invalid-response",
  );
});

test("aborts after the configured timeout", async () => {
  const fetchImpl: FetchLike = async (_input, init = {}) =>
    await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  await assert.rejects(
    generateCompletion(messages, {
      config: {
        ...loadConfig({ YANDEX_FOLDER_ID: "folder-id" }),
        timeoutMs: 5,
      },
      iamToken: "iam-token",
      fetchImpl,
    }),
    (error: unknown) => error instanceof LlmError && error.kind === "timeout",
  );
});
