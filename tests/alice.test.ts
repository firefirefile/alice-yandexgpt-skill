import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAliceResponse,
  extractCommand,
  getRawSessionState,
  getSessionId,
  isHealthCheck,
  isNewSession,
  normalizeAliceText,
} from "../src/alice";

test("extracts command from a SimpleUtterance", () => {
  assert.equal(
    extractCommand({
      request: { type: "SimpleUtterance", command: "  привет  " },
    }),
    "привет",
  );
  assert.equal(extractCommand({ request: { command: 42 } }), "");
});

test("recognizes ping from original_utterance", () => {
  assert.equal(
    isHealthCheck({ request: { original_utterance: "ping" } }),
    true,
  );
  assert.equal(
    isHealthCheck({ request: { original_utterance: "пинг" } }),
    false,
  );
});

test("detects new sessions safely", () => {
  assert.equal(isNewSession({ session: { new: true } }), true);
  assert.equal(isNewSession(null), false);
  assert.equal(isNewSession([]), false);
  assert.equal(getSessionId({ session: { session_id: "session-1" } }), "session-1");
  assert.equal(getSessionId({ session: { session_id: 1 } }), undefined);
  assert.deepEqual(
    getRawSessionState({ state: { session: { v: 1, history: [] } } }),
    { v: 1, history: [] },
  );
});

test("normalizes and bounds response text", () => {
  assert.equal(normalizeAliceText("  Привет,   мир!\n Как дела? "), "Привет, мир! Как дела?");
  assert.equal(normalizeAliceText("   "), "Не получилось сформировать ответ. Попробуй ещё раз.");
  assert.ok(normalizeAliceText("я ".repeat(2000)).length <= 1024);
});

test("builds the protocol 1.0 response", () => {
  assert.deepEqual(buildAliceResponse("Привет", { v: 1, history: [] }), {
    response: { text: "Привет", end_session: false },
    session_state: { v: 1, history: [] },
    version: "1.0",
  });

  assert.deepEqual(buildAliceResponse("Привет"), {
    response: { text: "Привет", end_session: false },
    version: "1.0",
  });
});
