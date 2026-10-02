import { lookup } from "./jsonpath.ts";
import type { HttpSender } from "./ports.ts";
import type { PreparedRequest } from "./prepare.ts";
import type { ExecutionResult, RequestModel } from "./types.ts";

export const MAX_BODY_BYTES = 1024 * 1024;

/** Pasa la petición preparada por el puerto `HttpSender`: el núcleo no conoce
 * la red, solo el contrato. */
export function sendPrepared(
  send: HttpSender,
  prepared: PreparedRequest,
  followRedirects: boolean,
  signal: AbortSignal,
): Promise<Response> {
  return send(prepared.url, {
    method: prepared.method,
    headers: prepared.headers,
    body: prepared.body,
    redirect: followRedirects ? "follow" : "manual",
    cache: "no-store",
    signal,
  });
}

/** Lee el cuerpo respetando el tope; el exceso se trunca y se marca. */
export async function readLimitedBody(response: Response, limit: number): Promise<{ buffer: ArrayBuffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const full = await response.arrayBuffer();
    if (full.byteLength <= limit) return { buffer: full, truncated: false };
    return { buffer: full.slice(0, limit), truncated: true };
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  while (received < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const room = limit - received;
    if (value.byteLength > room) {
      chunks.push(value.slice(0, room));
      received += room;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    received += value.byteLength;
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { buffer: merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength), truncated };
}

/** Extrae los valores de los extractores de la petición desde la respuesta. */
export function extractValues(
  request: RequestModel,
  result: Pick<ExecutionResult, "headers" | "bodyJson">,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const extractor of request.extractors) {
    const name = extractor.name.trim();
    if (!name) continue;
    if (extractor.source === "header") {
      const header = result.headers.find((item) => item.name.toLowerCase() === extractor.path.trim().toLowerCase());
      if (header) out[name] = header.value;
      continue;
    }
    if (result.bodyJson === null || result.bodyJson === undefined) continue;
    const got = lookup(result.bodyJson, extractor.path);
    if (!got.found || got.value === undefined || got.value === null) continue;
    out[name] = typeof got.value === "string" ? got.value : JSON.stringify(got.value);
  }
  return out;
}

/** Headers visibles para el usuario: sin doble set-cookie, pero sí el valor. */
export function collectHeaders(response: Response): { name: string; value: string }[] {
  const headers: { name: string; value: string }[] = [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return;
    headers.push({ name, value });
  });
  if (typeof response.headers.getSetCookie === "function") {
    for (const cookie of response.headers.getSetCookie()) headers.push({ name: "set-cookie", value: cookie });
  }
  return headers;
}

export function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

export function isBinary(type: string, buffer: ArrayBuffer): boolean {
  if (/json|text|xml|javascript|svg|x-www-form-urlencoded|\+json/.test(type)) return false;
  if (!type) {
    const sample = new Uint8Array(buffer.slice(0, 32));
    return sample.some((byte) => byte === 0);
  }
  return true;
}

export function decodeText(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}
