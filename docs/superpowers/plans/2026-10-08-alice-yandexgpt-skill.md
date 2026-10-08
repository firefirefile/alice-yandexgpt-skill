# Alice YandexGPT Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deployable private Alice skill whose Yandex Cloud Function sends real user utterances to YandexGPT Lite 5 and returns generated spoken responses with bounded in-session context.

**Architecture:** A single Node.js 22 Cloud Function returns the Alice protocol object directly. Focused TypeScript modules own the Alice adapter, bounded `session_state`, YandexGPT REST client, configuration, and system prompt; the handler composes them and injects the generator for network-free tests.

**Tech Stack:** Node.js 22, TypeScript, built-in `fetch`/`AbortController`, `node:test`, `node:assert`, npm, ZIP deployment to Yandex Cloud Functions.

**Spec:** `docs/superpowers/specs/2026-10-08-alice-yandexgpt-skill-design.md`

## Global Constraints

- Use Node.js 22 and TypeScript; emit CommonJS for the Cloud Functions entry point `index.handler`.
- Add no runtime dependencies; dev dependencies are limited to `typescript` and `@types/node`.
- Use YandexGPT Lite 5 by default with `gpt://<YANDEX_FOLDER_ID>/yandexgpt-5-lite`.
- Abort the LLM request after `3200` ms by default; do not retry within a webhook request.
- Keep `response.text` at or below 1024 characters and serialized `session_state` at or below the internal 900-byte budget.
- Persist context only through Alice `session_state`; never rely on Cloud Function process memory.
- Prefer `context.token` IAM authorization; support `YANDEX_API_KEY` only as a fallback.
- Never log credentials or full conversation contents.
- Preserve platform and model safety filters; do not implement bypasses.

## Review Focus

- Malformed webhook values (`null`, arrays, missing nested fields) return a valid fallback response instead of throwing; pin in Task 4.
- Cyrillic and emoji are counted as UTF-8 bytes when enforcing the 900-byte state budget; pin in Task 2.
- A health-check `ping` succeeds without environment variables and never initializes the LLM client; pin in Task 4.
- A newest exchange that alone exceeds 900 bytes is omitted from persisted history while its response is still returned; pin in Task 2 and Task 4.
- IAM and API-key headers are mutually exclusive, IAM wins when both exist, and neither secret appears in thrown errors; pin in Task 3.

---

### Task 1: Project Foundation and Alice Protocol Adapter

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `.gitignore`
- Create: `src/alice.ts`
- Create: `tests/alice.test.ts`

**Interfaces:**
- Consumes: Raw `unknown` Cloud Function event values.
- Produces: `AliceRequest`, `AliceResponse`, `extractCommand(event: unknown): string`, `isHealthCheck(event: unknown): boolean`, `isNewSession(event: unknown): boolean`, `getSessionId(event: unknown): string | undefined`, `getRawSessionState(event: unknown): unknown`, `normalizeAliceText(text: string): string`, and `buildAliceResponse(text: string, sessionState?: unknown): AliceResponse`.

- [ ] **Step 1: Add minimal TypeScript project configuration**

Set `package.json` to private CommonJS, require Node `>=22`, and add scripts `typecheck`, `build`, and `test`. Configure `tsconfig.json` for strict `ES2022`, CommonJS, Node resolution, `rootDir: "."`, and test output in `build/`; make `tsconfig.build.json` include only `src/`, with `rootDir: "src"` and `outDir: "dist"`. Ignore `node_modules/`, `build/`, `dist/`, the deployment ZIP, `.env`, and coverage artifacts.

- [ ] **Step 2: Install the two approved dev dependencies**

Run: `npm install --save-dev typescript @types/node`

Expected: `package-lock.json` is created and `npm ls --depth=0` lists only `typescript` and `@types/node`.

- [ ] **Step 3: Write failing Alice adapter tests**

Add tests named `extracts command from a SimpleUtterance`, `recognizes ping from original_utterance`, `detects new sessions safely`, `normalizes and bounds response text`, and `builds the protocol 1.0 response`. Key assertions:

```ts
assert.equal(extractCommand({ request: { command: "  привет  " } }), "привет");
assert.equal(isHealthCheck({ request: { original_utterance: "ping" } }), true);
assert.equal(isNewSession(null), false);
assert.ok(normalizeAliceText("я ".repeat(2000)).length <= 1024);
assert.deepEqual(buildAliceResponse("Привет", { v: 1, history: [] }), {
  response: { text: "Привет", end_session: false },
  session_state: { v: 1, history: [] },
  version: "1.0",
});
```

- [ ] **Step 4: Run the adapter tests and confirm the red state**

Run: `npm test -- --test-name-pattern="Alice|command|ping|session|response"`

Expected: FAIL because `src/alice.ts` or its exports do not exist.

- [ ] **Step 5: Implement the minimal Alice adapter**

Use guarded record checks rather than unchecked casts. `normalizeAliceText` collapses whitespace, returns a non-empty generic fallback when needed, and truncates at a sentence/word boundary when possible without exceeding 1024 JavaScript characters.

- [ ] **Step 6: Verify Task 1**

Run: `npm run typecheck && npm test`

Expected: TypeScript exits 0 and all Task 1 tests pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json .gitignore src/alice.ts tests/alice.test.ts
git commit -m "feat: add Alice protocol adapter"
```

### Task 2: Bounded Session Conversation State

**Files:**
- Create: `src/conversation.ts`
- Create: `tests/conversation.test.ts`

**Interfaces:**
- Consumes: Raw `state.session`, `session.new`, a current user string, and a generated assistant string.
- Produces: `ChatMessage = { role: "user" | "assistant"; text: string }`, `ConversationState = { v: 1; history: ChatMessage[] }`, `readHistory(rawState: unknown, isNew: boolean): ChatMessage[]`, `appendExchange(history: ChatMessage[], userText: string, assistantText: string): ChatMessage[]`, `fitSessionState(history: ChatMessage[], maxBytes?: number): ConversationState`, and `sessionStateBytes(state: ConversationState): number`.

- [ ] **Step 1: Write failing conversation-state tests**

Add tests named `accepts only valid alternating history`, `clears history for a new session`, `appends a complete exchange`, `removes oldest complete pairs until state fits 900 bytes`, `measures Cyrillic and emoji as UTF-8`, and `drops an oversized newest exchange`. Key assertions:

```ts
assert.deepEqual(readHistory({ v: 1, history: [{ role: "user", text: "старое" }] }, true), []);
assert.deepEqual(appendExchange([], "вопрос", "ответ"), [
  { role: "user", text: "вопрос" },
  { role: "assistant", text: "ответ" },
]);
assert.ok(sessionStateBytes(fitSessionState(longHistory)) <= 900);
assert.ok(sessionStateBytes({ v: 1, history: [{ role: "user", text: "😀" }] }) > "😀".length);
assert.deepEqual(fitSessionState([{ role: "user", text: "я".repeat(1000) }, { role: "assistant", text: "а".repeat(1000) }]).history, []);
```

- [ ] **Step 2: Run the conversation tests and confirm the red state**

Run: `npm test -- --test-name-pattern="history|exchange|UTF-8|900|oversized"`

Expected: FAIL because `src/conversation.ts` does not exist.

- [ ] **Step 3: Implement conversation parsing and byte-bounded persistence**

Validate `v === 1`, roles, non-empty string text, and alternating complete pairs. Calculate bytes with `Buffer.byteLength(JSON.stringify(state), "utf8")`; remove two oldest messages at a time until the state is within `maxBytes` (default 900).

- [ ] **Step 4: Verify Task 2**

Run: `npm run typecheck && npm test`

Expected: all Task 1–2 tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/conversation.ts tests/conversation.test.ts
git commit -m "feat: add bounded session history"
```

### Task 3: Configuration and YandexGPT REST Client

**Files:**
- Create: `src/config.ts`
- Create: `src/yandex-gpt.ts`
- Create: `tests/yandex-gpt.test.ts`
- Create: `.env.example`

**Interfaces:**
- Consumes: LLM messages, environment variables, optional Cloud Function IAM token, and an injectable `typeof fetch`.
- Produces: `LlmMessage = { role: "system" | "user" | "assistant"; text: string }`, `AppConfig`, `loadConfig(env: NodeJS.ProcessEnv): AppConfig`, `LlmError` with kinds `config | auth | timeout | filtered | provider | invalid-response`, `GenerateCompletionOptions`, and `generateCompletion(messages: LlmMessage[], options: GenerateCompletionOptions): Promise<string>`.

- [ ] **Step 1: Write failing configuration and client tests**

Add tests named `loads documented defaults`, `rejects a missing folder id`, `sends the documented completion request`, `prefers IAM bearer auth`, `falls back to Api-Key auth`, `rejects missing auth without exposing secrets`, `classifies content filtering`, `classifies non-2xx provider responses`, `rejects an empty alternative`, and `aborts after the configured timeout`. Assert the request includes:

```ts
assert.equal(url, "https://ai.api.cloud.yandex.net/foundationModels/v1/completion");
assert.equal(body.modelUri, "gpt://folder-id/yandexgpt-5-lite");
assert.deepEqual(body.completionOptions, {
  stream: false,
  temperature: 0.8,
  maxTokens: "180",
});
assert.equal(headers.Authorization, "Bearer iam-token");
assert.equal(headers["x-folder-id"], "folder-id");
```

The success fixture returns `result.alternatives[0].message.text`; the filtered fixture uses `ALTERNATIVE_STATUS_CONTENT_FILTER`. Verify serialized errors contain neither test IAM nor API-key values.

- [ ] **Step 2: Run the YandexGPT tests and confirm the red state**

Run: `npm test -- --test-name-pattern="YandexGPT|auth|folder|filtered|timeout|alternative"`

Expected: FAIL because configuration and client exports do not exist.

- [ ] **Step 3: Implement strict environment parsing**

`loadConfig` requires `YANDEX_FOLDER_ID`, defaults model/timeout/max tokens/temperature to `yandexgpt-5-lite`/`3200`/`180`/`0.8`, rejects non-finite or out-of-range numeric values, and reads optional `YANDEX_API_KEY` without ever interpolating it into an error.

- [ ] **Step 4: Implement the synchronous REST client**

POST JSON to the exact endpoint asserted above. Send messages unchanged, select `Bearer <iamToken>` before `Api-Key <config.apiKey>`, add `Content-Type` and `x-folder-id`, abort with `AbortController`, clear the timer in `finally`, and map status/filter/shape failures to `LlmError`.

- [ ] **Step 5: Add the environment template**

Document `YANDEX_FOLDER_ID`, optional `YANDEX_GPT_MODEL`, optional local-only `YANDEX_API_KEY`, `LLM_TIMEOUT_MS=3200`, `LLM_MAX_TOKENS=180`, and `LLM_TEMPERATURE=0.8`; include no real secret.

- [ ] **Step 6: Verify Task 3**

Run: `npm run typecheck && npm test`

Expected: all Task 1–3 tests pass, including timeout and secret-redaction cases.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/config.ts src/yandex-gpt.ts tests/yandex-gpt.test.ts .env.example
git commit -m "feat: add YandexGPT client"
```

### Task 4: Persona and Cloud Function Handler

**Files:**
- Create: `src/system-prompt.ts`
- Create: `src/index.ts`
- Create: `tests/handler.test.ts`

**Interfaces:**
- Consumes: Alice event, `{ token?: string }` Cloud Function context, protocol helpers, bounded history, configuration, and YandexGPT client.
- Produces: `SYSTEM_PROMPT: string`, `GenerateReply = (messages: LlmMessage[], context: FunctionContext) => Promise<string>`, `createHandler(deps: { generateReply: GenerateReply; logger?: Logger }): Handler`, and exported production `handler(event: unknown, context: FunctionContext): Promise<AliceResponse>`.

- [ ] **Step 1: Write failing handler tests for non-LLM paths**

Add tests named `returns pong without initializing LLM`, `greets a new empty session`, `asks to repeat an empty continuing utterance`, and `returns protocol fallback for null array and malformed events`. Assert `generateReply` call count stays zero and every result has `version === "1.0"`, `end_session === false`, and text no longer than 1024 characters.

- [ ] **Step 2: Run the non-LLM handler tests and confirm the red state**

Run: `npm test -- --test-name-pattern="pong|greets|repeat|malformed"`

Expected: FAIL because `src/index.ts` does not exist.

- [ ] **Step 3: Implement the system prompt and non-LLM branches**

The prompt must encode the approved Russian persona, concise voice-friendly answers, no claim of being official Alice, use of session context, and no attempt to bypass provider filters. Branch order is health check, request validation, new empty session, continuing empty command, then LLM.

- [ ] **Step 4: Write failing handler tests for generated replies and failures**

Add tests named `sends system history and current user messages`, `ignores incoming history on a new session`, `persists only a successful bounded exchange`, `returns an oversized reply but omits an oversized exchange from state`, `keeps old state on timeout`, and `maps filtered auth and provider failures to user fallbacks`. Key assertions:

```ts
assert.deepEqual(messages.map(({ role }) => role), ["system", "user", "assistant", "user"]);
assert.equal(result.response.text, "Сгенерированный ответ");
assert.ok(Buffer.byteLength(JSON.stringify(result.session_state), "utf8") <= 900);
assert.deepEqual(timeoutResult.session_state, previousState);
```

- [ ] **Step 5: Run the generated-reply tests and confirm the red state**

Run: `npm test -- --test-name-pattern="system|persists|oversized reply|timeout|filtered|provider"`

Expected: FAIL because the LLM path is not implemented.

- [ ] **Step 6: Implement handler composition and production wiring**

`createHandler` uses the injected generator. The production generator loads config only on an LLM path, calls `generateCompletion` with `context.token`, logs only category/status/duration/session ID, and returns Russian fallback copy per `LlmError.kind`. Normalize the successful reply before persisting and returning it.

- [ ] **Step 7: Verify Task 4**

Run: `npm run typecheck && npm test && npm run build`

Expected: all tests pass and `dist/index.js` exports `handler`.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/system-prompt.ts src/index.ts tests/handler.test.ts
git commit -m "feat: connect Alice handler to YandexGPT"
```

### Task 5: Deployment Artifact and Operator README

**Files:**
- Modify: `package.json`
- Create: `README.md`

**Interfaces:**
- Consumes: compiled `dist/*.js`, Yandex Cloud account/folder, service account, and a private Alice skill.
- Produces: `npm run package` creating `alice-yandexgpt-skill.zip`, plus complete console-first and CLI deployment instructions.

- [ ] **Step 1: Add and run the deployment packaging script**

Add the Unix/macOS-compatible script `"package": "npm run build && cd dist && zip -r -FS ../alice-yandexgpt-skill.zip ."`. It creates or synchronizes `alice-yandexgpt-skill.zip` from the contents of `dist/`, so `index.js` is at the archive root and stale archive entries are removed.

Run: `npm run package`

Expected: the command exits 0 and creates the ZIP.

- [ ] **Step 2: Verify the archive layout before documenting it**

Run: `unzip -l alice-yandexgpt-skill.zip`

Expected: `index.js`, `alice.js`, `config.js`, `conversation.js`, `system-prompt.js`, and `yandex-gpt.js` appear at archive root; no `src/`, tests, `.env`, or `node_modules/` appear.

- [ ] **Step 3: Write the complete README**

Cover prerequisites and billing; local install/typecheck/test/build; persona editing; every environment variable; service account creation and folder-level `ai.languageModels.user`; Node.js 22 function creation with entry point `index.handler`, 128 MB, 5-second function timeout, service account, and ZIP; equivalent `yc` commands; direct Dialogs backend selection as «Функция в Яндекс Облаке» with `functions.functionInvoker`; enabling skill storage; selecting private access; testing the empty greeting and a real generated phrase; logs and troubleshooting for 401/403, 429, timeout, filter, malformed response, and state limits. Link the official request, response, state, function, IAM, model, and moderation docs from the spec.

- [ ] **Step 4: Run the clean verification suite**

Run: `npm run typecheck && npm test && npm run package && unzip -t alice-yandexgpt-skill.zip`

Expected: typecheck and tests exit 0, packaging succeeds, and unzip reports no errors.

- [ ] **Step 5: Inspect the final diff for secrets and scope drift**

Run: `git diff --check && git status --short && rg -n "Api-Key |Bearer |YANDEX_API_KEY=" . --glob '!package-lock.json' --glob '!docs/**'`

Expected: no whitespace errors; only expected project files are uncommitted; no literal credential follows an auth prefix or environment assignment.

- [ ] **Step 6: Commit Task 5**

```bash
git add package.json README.md
git commit -m "docs: add Yandex Cloud deployment guide"
```

### Task 6: Final Requirement Verification

**Files:**
- Modify only if verification exposes a defect in an earlier task.

**Interfaces:**
- Consumes: the full repository and approved design specification.
- Produces: evidence that source, tests, artifact, and documentation meet the MVP acceptance criteria.

- [ ] **Step 1: Verify repository tests and build from the committed tree**

Run: `npm ci && npm run typecheck && npm test && npm run package`

Expected: every command exits 0.

- [ ] **Step 2: Smoke-test the compiled handler without network access**

Run a Node.js one-liner against `dist/index.js` with an Alice `ping` fixture.

Expected: the resolved object contains `response.text === "pong"`, `response.end_session === false`, and `version === "1.0"`.

- [ ] **Step 3: Audit the artifact and documentation against the spec**

Confirm the ZIP contains only deployable JavaScript, README uses `yandexgpt-5-lite`, `3200`, `180`, `0.8`, Node.js 22, `index.handler`, 128 MB, 5 seconds, private access, and `session_state`; confirm no README step claims cross-session persistence or guaranteed profanity.

- [ ] **Step 4: Record any verification-only fixes in a final commit**

If and only if Step 1–3 required changes, rerun all verification and commit them:

```bash
git add <only-the-fixed-files>
git commit -m "fix: complete Alice skill verification"
```
