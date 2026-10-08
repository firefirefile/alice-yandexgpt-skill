import assert from "node:assert/strict";
import test from "node:test";

import { createHandler, DEFAULT_MOCK_RESPONSE } from "../src/index";

function aliceEvent(options: {
  command?: string;
  isNew?: boolean;
  state?: unknown;
} = {}): Record<string, unknown> {
  return {
    version: "1.0",
    request: {
      command: options.command ?? "",
      original_utterance: options.command ?? "",
      type: "SimpleUtterance",
    },
    session: {
      new: options.isNew ?? false,
      session_id: "test-session",
    },
    state: {
      session: options.state ?? {},
    },
  };
}

test("returns pong for a health check", async () => {
  const response = await createHandler()({ request: { original_utterance: "ping" } });
  assert.equal(response.response.text, "pong");
  assert.equal(response.response.end_session, false);
});

test("greets a new empty session without calling an external service", async () => {
  const response = await createHandler()(aliceEvent({ isNew: true }));
  assert.equal(response.response.text, "Ну привет. Скажи что-нибудь для проверки.");
});

test("asks to repeat an empty continuing utterance", async () => {
  const response = await createHandler()(aliceEvent());
  assert.equal(response.response.text, "Не расслышал. Повтори ещё раз.");
});

test("returns a protocol fallback for malformed events", async () => {
  const response = await createHandler()(null);
  assert.equal(response.version, "1.0");
  assert.equal(response.response.text, "Не получилось разобрать запрос. Повтори ещё раз.");
});

test("returns the default mock response for any user command", async () => {
  const response = await createHandler()(aliceEvent({ command: "Как дела?" }));
  assert.equal(response.response.text, DEFAULT_MOCK_RESPONSE);
});

test("uses MOCK_RESPONSE-compatible custom text", async () => {
  const response = await createHandler({ responseText: "  Всё работает.  " })(
    aliceEvent({ command: "Проверка" }),
  );
  assert.equal(response.response.text, "Всё работает.");
});

test("stores the mocked exchange in session_state", async () => {
  const response = await createHandler({ responseText: "Тестовый ответ" })(
    aliceEvent({ command: "Тестовый вопрос" }),
  );

  assert.deepEqual(response.session_state, {
    v: 1,
    history: [
      { role: "user", text: "Тестовый вопрос" },
      { role: "assistant", text: "Тестовый ответ" },
    ],
  });
});
