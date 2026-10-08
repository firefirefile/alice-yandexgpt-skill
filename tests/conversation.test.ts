import assert from "node:assert/strict";
import test from "node:test";

import {
  appendExchange,
  fitSessionState,
  readHistory,
  sessionStateBytes,
  type ChatMessage,
} from "../src/conversation";

test("accepts only valid alternating history", () => {
  const valid: ChatMessage[] = [
    { role: "user", text: "вопрос" },
    { role: "assistant", text: "ответ" },
  ];

  assert.deepEqual(readHistory({ v: 1, history: valid }, false), valid);
  assert.deepEqual(
    readHistory({ v: 1, history: [{ role: "assistant", text: "лишнее" }] }, false),
    [],
  );
  assert.deepEqual(
    readHistory({ v: 1, history: [{ role: "user", text: "" }] }, false),
    [],
  );
  assert.deepEqual(readHistory({ v: 2, history: valid }, false), []);
  assert.deepEqual(readHistory(null, false), []);
});

test("clears history for a new session", () => {
  assert.deepEqual(
    readHistory(
      {
        v: 1,
        history: [
          { role: "user", text: "старое" },
          { role: "assistant", text: "старый ответ" },
        ],
      },
      true,
    ),
    [],
  );
});

test("appends a complete exchange", () => {
  assert.deepEqual(appendExchange([], " вопрос ", " ответ "), [
    { role: "user", text: "вопрос" },
    { role: "assistant", text: "ответ" },
  ]);
});

test("removes oldest complete pairs until state fits 900 bytes", () => {
  const longHistory: ChatMessage[] = Array.from({ length: 10 }, (_, index) => [
    { role: "user" as const, text: `вопрос-${index}-${"я".repeat(80)}` },
    { role: "assistant" as const, text: `ответ-${index}-${"а".repeat(80)}` },
  ]).flat();

  const state = fitSessionState(longHistory);

  assert.ok(sessionStateBytes(state) <= 900);
  assert.equal(state.history.length % 2, 0);
  assert.equal(state.history.at(-2)?.text.startsWith("вопрос-9-"), true);
  assert.equal(state.history.at(-1)?.text.startsWith("ответ-9-"), true);
});

test("measures Cyrillic and emoji as UTF-8", () => {
  const state = {
    v: 1 as const,
    history: [{ role: "user" as const, text: "Привет 😀" }],
  };

  assert.equal(sessionStateBytes(state), Buffer.byteLength(JSON.stringify(state), "utf8"));
  assert.ok(sessionStateBytes(state) > JSON.stringify(state).length);
});

test("drops an oversized newest exchange", () => {
  const state = fitSessionState([
    { role: "user", text: "я".repeat(1000) },
    { role: "assistant", text: "а".repeat(1000) },
  ]);

  assert.deepEqual(state.history, []);
  assert.ok(sessionStateBytes(state) <= 900);
});
