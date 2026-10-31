/**
 * Chat response guard for the InferHub gateway's error wrapping.
 *
 * Pre-model failures (rate limit, model not registered, invalid params) come
 * back as HTTP 200 + `text/event-stream` containing a single pseudo-SSE line
 * (`data:{"text":"[DONE]","error_code":...}`), then the stream closes. The
 * OpenAI SDK parses no chunks and never sees a finish_reason, surfacing the
 * misleading "OpenAI Chat stream ended without finish_reason".
 *
 * The guard restores protocol shape — nothing more: it peeks the first SSE
 * event, and when it carries `error_code` it cancels the body and returns a
 * plain non-2xx JSON error response with the embedded HTTP status (e.g.
 * `InferHub.ModelArts.81114.429` → 429). The HOST owns policy: opencode's
 * native 429 retry/backoff and error rendering take over from there. Healthy
 * streams are replayed byte-identical.
 */

export type SseError = { code: string; msg: string };

/** Extracts `{error_code, error_msg}` from one SSE `data:` payload. */
export function extractSseError(payload: string | null): SseError | null {
  if (!payload || payload === "[DONE]") return null;
  try {
    const obj = JSON.parse(payload) as {
      error_code?: unknown;
      error_msg?: unknown;
    };
    if (obj && typeof obj.error_code === "string" && obj.error_code) {
      return {
        code: obj.error_code,
        msg: typeof obj.error_msg === "string" ? obj.error_msg : "",
      };
    }
  } catch {
    // not JSON — a healthy chunk never reaches here (callers only pass
    // `data:` payloads), keep it as non-error and let it stream through
  }
  return null;
}

/** The pseudo-error embeds the HTTP status in the code's last segment
 * (`InferHub.ModelArts.81114.429` → 429); unknown shapes map to 502. */
export function statusFromSseError(e: SseError): number {
  const m = /(\d{3})$/.exec(e.code);
  const status = m ? Number(m[1]) : 0;
  return status >= 400 && status <= 599 ? status : 502;
}

export function sseErrorMessage(e: SseError): string {
  return `CodeArts InferHub error ${e.code}${e.msg ? `: ${e.msg}` : ""}`;
}

/** Replays already-peeked bytes, then pumps the remainder unchanged. */
function replayStream(
  peeked: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (peeked.length) controller.enqueue(peeked.shift()!);
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}

/** Wraps a chat-completions Response: passes healthy streams (and plain
 * non-2xx errors, which the SDK already renders) through untouched, and
 * rewrites the gateway's pseudo-SSE error wrapping into a real non-2xx
 * JSON error. */
export async function guardChatResponse(res: Response): Promise<Response> {
  if (!res.ok) return res;
  const ct = res.headers?.get?.("content-type") ?? "";
  if (!ct.includes("text/event-stream") || !res.body) return res;

  // Peek just the first SSE line: pre-model errors are a single small line
  // that always arrives before any content chunk.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const peeked: Uint8Array[] = [];
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    peeked.push(value);
    buf += decoder.decode(value, { stream: true });
    if (buf.includes("\n")) break;
  }
  if (!peeked.length) {
    // Body already consumed via the reader — return a fresh (empty) Response
    // with the original status/headers instead of the disturbed one.
    void reader.cancel().catch(() => {});
    return new Response(null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  const firstLine = buf.includes("\n") ? buf.slice(0, buf.indexOf("\n")) : buf;
  const payload = firstLine.trim().startsWith("data:")
    ? firstLine.trim().slice(5).trim()
    : null;
  const err = extractSseError(payload);
  if (!err) {
    // Healthy start: replay the peeked bytes + the rest, byte-identical.
    return new Response(replayStream(peeked, reader), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  await reader.cancel().catch(() => {});
  return new Response(
    JSON.stringify({
      error: { message: sseErrorMessage(err), code: err.code },
    }),
    {
      status: statusFromSseError(err),
      headers: { "content-type": "application/json" },
    },
  );
}
