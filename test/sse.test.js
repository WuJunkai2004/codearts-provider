import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSseError,
  statusFromSseError,
  sseErrorMessage,
  guardChatResponse,
} from "../.tsc/utils/sse.js";
import { createSignedFetch } from "../.tsc/utils/signer.js";

const AK = "TESTAK";
const SK = "TESTSK";

// Pseudo-SSE error lines as actually observed on the wire (see README
// troubleshooting): HTTP 200 + text/event-stream + one error line.
const RATE_LIMIT_LINE =
  'data:{"text":"[DONE]","error_code":"InferHub.ModelArts.81114.429","error_msg":"Too many requests, the rate limit is 5000000 tokens per minute"}\n\n';
const NOT_REGISTERED_LINE =
  'data:{"text":"[DONE]","error_code":"InferHub.002002009.404","error_msg":"The model is not registered, please request other model"}\n\n';

const CHUNK =
  'data:{"id":"x","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
  'data:{"id":"x","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data:[DONE]\n\n";

const sseResponse = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });

test("extractSseError: detects error_code payloads, ignores healthy ones", () => {
  const e = extractSseError(
    '{"text":"[DONE]","error_code":"InferHub.002002009.404","error_msg":"not registered"}',
  );
  assert.deepEqual(e, {
    code: "InferHub.002002009.404",
    msg: "not registered",
  });
  assert.equal(extractSseError("[DONE]"), null);
  assert.equal(extractSseError(null), null);
  assert.equal(
    extractSseError('{"choices":[{"delta":{"content":"hi"}}]}'),
    null,
    "healthy chunk is not an error",
  );
  assert.equal(extractSseError("not-json"), null, "non-JSON passthrough");
});

test("statusFromSseError: embedded HTTP status, else 502", () => {
  assert.equal(
    statusFromSseError({ code: "InferHub.ModelArts.81114.429", msg: "" }),
    429,
  );
  assert.equal(
    statusFromSseError({ code: "InferHub.002002009.404", msg: "" }),
    404,
  );
  assert.equal(statusFromSseError({ code: "TM.00001041", msg: "" }), 502);
  assert.equal(
    statusFromSseError({ code: "X.200", msg: "" }),
    502,
    "2xx not accepted",
  );
});

test("sseErrorMessage includes code and msg", () => {
  const msg = sseErrorMessage({
    code: "InferHub.ModelArts.81114.429",
    msg: "Too many requests",
  });
  assert.match(
    msg,
    /^CodeArts InferHub error InferHub\.ModelArts\.81114\.429: Too many requests$/,
  );
});

test("guardChatResponse: pseudo-SSE rate limit error → real 429 JSON error", async () => {
  const out = await guardChatResponse(sseResponse(RATE_LIMIT_LINE));
  assert.equal(out.status, 429, "embedded 429 preserved");
  const body = await out.json();
  assert.match(body.error.message, /InferHub\.ModelArts\.81114\.429/);
  assert.match(body.error.message, /Too many requests/);
  assert.equal(body.error.code, "InferHub.ModelArts.81114.429");
});

test("guardChatResponse: not-registered error → 404 with clean message", async () => {
  const out = await guardChatResponse(sseResponse(NOT_REGISTERED_LINE));
  assert.equal(out.status, 404);
  const body = await out.json();
  assert.match(body.error.message, /not registered/);
});

test("guardChatResponse: healthy stream replays byte-identical", async () => {
  const out = await guardChatResponse(sseResponse(CHUNK));
  assert.equal(out.status, 200);
  assert.equal(await out.text(), CHUNK, "body untouched");
});

test("guardChatResponse: first SSE line split across chunks still passes through", async () => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const bytes = enc.encode(CHUNK);
      controller.enqueue(bytes.slice(0, 20));
      controller.enqueue(bytes.slice(20));
      controller.close();
    },
  });
  const res = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const out = await guardChatResponse(res);
  assert.equal(out.status, 200);
  assert.equal(await out.text(), CHUNK, "split chunk reassembled untouched");
});

test("guardChatResponse: non-event-stream responses untouched", async () => {
  const json = JSON.stringify({ ok: true });
  const res = new Response(json, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const out = await guardChatResponse(res);
  assert.equal(out, res, "same Response object returned");
});

test("guardChatResponse: non-2xx responses untouched (SDK renders them)", async () => {
  const res = new Response('{"error_code":"TM.00001041"}', {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  const out = await guardChatResponse(res);
  assert.equal(out, res, "same Response object returned");
});

test("guardChatResponse: empty body → untouched", async () => {
  const out = await guardChatResponse(sseResponse(""));
  assert.equal(await out.text(), "");
});

test("createSignedFetch: chat pseudo-SSE error surfaces as readable non-2xx", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(RATE_LIMIT_LINE);
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const signedFetch = createSignedFetch(AK, SK);
  const res = await signedFetch("https://example.com/api/v2/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "kimi-k3.1-pro", messages: [] }),
  });
  assert.equal(res.status, 429, "status rewritten from embedded code");
  const body = await res.json();
  assert.match(body.error.message, /81114\.429/);
});

test("createSignedFetch: chat healthy SSE stream passes through untouched", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(CHUNK);
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const signedFetch = createSignedFetch(AK, SK);
  const res = await signedFetch("https://example.com/api/v2/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "GLM-5.2", messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), CHUNK);
});
