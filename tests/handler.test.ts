import assert from "node:assert/strict";
import test from "node:test";

import { createHandler, handler as productionHandler, type GenerateReply } from "../src/index";
import { LlmError, type LlmMessage } from "../src/yandex-gpt";

function createUnusedGenerator(): {
  generateReply: GenerateReply;
  calls: () => number;
} {
  let callCount = 0;
  return {
    generateReply: async () => {
      callCount += 1;
      return "не должен вызываться";
    },
    calls: () => callCount,
  };
}

function assertValidResponse(result: Awaited<ReturnType<ReturnType<typeof createHandler>>>): void {
  assert.equal(result.version, "1.0");
  assert.equal(result.response.end_session, false);
  assert.ok(result.response.text.length > 0);
  assert.ok(result.response.text.length <= 1024);
}

test("returns pong without initializing LLM", async () => {
  const generator = createUnusedGenerator();
  const handler = createHandler({ generateReply: generator.generateReply });

  const result = await handler(
    { request: { original_utterance: "ping", command: "" } },
    {},
  );

  assert.equal(result.response.text, "pong");
  assert.equal(generator.calls(), 0);
  assertValidResponse(result);
});

test("greets a new empty session", async () => {
  const generator = createUnusedGenerator();
  const handler = createHandler({ generateReply: generator.generateReply });

  const result = await handler(
    {
      request: { type: "SimpleUtterance", command: "", original_utterance: "" },
      session: { new: true, session_id: "new-session" },
      version: "1.0",
    },
    {},
  );

  assert.match(result.response.text, /говори|спрашивай/iu);
  assert.deepEqual(result.session_state, { v: 1, history: [] });
  assert.equal(generator.calls(), 0);
  assertValidResponse(result);
});

test("asks to repeat an empty continuing utterance", async () => {
  const generator = createUnusedGenerator();
  const handler = createHandler({ generateReply: generator.generateReply });

  const result = await handler(
    {
      request: { type: "SimpleUtterance", command: "", original_utterance: "" },
      session: { new: false, session_id: "current-session" },
      state: {
        session: {
          v: 1,
          history: [
            { role: "user", text: "старый вопрос" },
            { role: "assistant", text: "старый ответ" },
          ],
        },
      },
      version: "1.0",
    },
    {},
  );

  assert.match(result.response.text, /повтори/iu);
  assert.deepEqual(result.session_state, {
    v: 1,
    history: [
      { role: "user", text: "старый вопрос" },
      { role: "assistant", text: "старый ответ" },
    ],
  });
  assert.equal(generator.calls(), 0);
  assertValidResponse(result);
});

test("returns protocol fallback for null array and malformed events", async () => {
  const generator = createUnusedGenerator();
  const handler = createHandler({ generateReply: generator.generateReply });

  for (const event of [null, [], {}, { request: "bad" }]) {
    const result = await handler(event, {});
    assert.match(result.response.text, /запрос|повтори/iu);
    assertValidResponse(result);
  }
  assert.equal(generator.calls(), 0);
});

test("production handler returns ping without environment configuration", async () => {
  const result = await productionHandler(
    { request: { original_utterance: "ping", command: "" } },
    {},
  );

  assert.equal(result.response.text, "pong");
});

test("sends system history and current user messages", async () => {
  let capturedMessages: LlmMessage[] = [];
  const handler = createHandler({
    generateReply: async (messages) => {
      capturedMessages = messages;
      return "Сгенерированный ответ";
    },
  });

  const result = await handler(
    {
      request: { type: "SimpleUtterance", command: "новый вопрос" },
      session: { new: false, session_id: "session-1" },
      state: {
        session: {
          v: 1,
          history: [
            { role: "user", text: "старый вопрос" },
            { role: "assistant", text: "старый ответ" },
          ],
        },
      },
      version: "1.0",
    },
    {},
  );

  assert.deepEqual(capturedMessages.map(({ role }) => role), [
    "system",
    "user",
    "assistant",
    "user",
  ]);
  assert.match(capturedMessages[0]?.text ?? "", /неофициальный|неформально/iu);
  assert.equal(capturedMessages.at(-1)?.text, "новый вопрос");
  assert.equal(result.response.text, "Сгенерированный ответ");
});

test("ignores incoming history on a new session", async () => {
  let capturedMessages: LlmMessage[] = [];
  const handler = createHandler({
    generateReply: async (messages) => {
      capturedMessages = messages;
      return "новый ответ";
    },
  });

  await handler(
    {
      request: { type: "SimpleUtterance", command: "начинаем заново" },
      session: { new: true, session_id: "new-session" },
      state: {
        session: {
          v: 1,
          history: [
            { role: "user", text: "не должно попасть" },
            { role: "assistant", text: "тоже не должно" },
          ],
        },
      },
      version: "1.0",
    },
    {},
  );

  assert.deepEqual(capturedMessages.map(({ role }) => role), ["system", "user"]);
  assert.equal(capturedMessages[1]?.text, "начинаем заново");
});

test("persists only a successful bounded exchange", async () => {
  const handler = createHandler({ generateReply: async () => "короткий ответ" });

  const result = await handler(
    {
      request: { type: "SimpleUtterance", command: "короткий вопрос" },
      session: { new: false, session_id: "session-2" },
      state: { session: { v: 1, history: [] } },
      version: "1.0",
    },
    {},
  );

  assert.deepEqual(result.session_state, {
    v: 1,
    history: [
      { role: "user", text: "короткий вопрос" },
      { role: "assistant", text: "короткий ответ" },
    ],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result.session_state), "utf8") <= 900);
});

test("returns an oversized reply but omits an oversized exchange from state", async () => {
  const handler = createHandler({
    generateReply: async () => "очень длинный ответ ".repeat(200),
  });

  const result = await handler(
    {
      request: { type: "SimpleUtterance", command: "вопрос" },
      session: { new: false, session_id: "session-3" },
      state: { session: { v: 1, history: [] } },
      version: "1.0",
    },
    {},
  );

  assert.ok(result.response.text.length > 0);
  assert.ok(result.response.text.length <= 1024);
  assert.deepEqual(result.session_state, { v: 1, history: [] });
});

test("keeps old state on timeout", async () => {
  const previousState = {
    v: 1 as const,
    history: [
      { role: "user" as const, text: "старый вопрос" },
      { role: "assistant" as const, text: "старый ответ" },
    ],
  };
  const handler = createHandler({
    generateReply: async () => {
      throw new LlmError("timeout", "таймаут");
    },
  });

  const result = await handler(
    {
      request: { type: "SimpleUtterance", command: "новый вопрос" },
      session: { new: false, session_id: "session-4" },
      state: { session: previousState },
      version: "1.0",
    },
    {},
  );

  assert.match(result.response.text, /тормозит|ещё раз/iu);
  assert.deepEqual(result.session_state, previousState);
});

test("maps filtered auth and provider failures to user fallbacks", async () => {
  const cases: Array<{ kind: "filtered" | "auth" | "provider"; expected: RegExp }> = [
    { kind: "filtered", expected: /не смогла ответить|другой вопрос/iu },
    { kind: "auth", expected: /настройк|недоступна/iu },
    { kind: "provider", expected: /недоступна|ещё раз/iu },
  ];

  for (const item of cases) {
    const handler = createHandler({
      generateReply: async () => {
        throw new LlmError(item.kind, "provider details", 500);
      },
    });
    const result = await handler(
      {
        request: { type: "SimpleUtterance", command: "вопрос" },
        session: { new: false, session_id: `session-${item.kind}` },
        state: { session: { v: 1, history: [] } },
        version: "1.0",
      },
      {},
    );

    assert.match(result.response.text, item.expected);
    assert.deepEqual(result.session_state, { v: 1, history: [] });
  }
});
