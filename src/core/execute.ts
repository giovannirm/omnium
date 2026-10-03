import { evaluateAssertions, stepPassed } from "./assertions.ts";
import { CookieJar } from "./cookies.ts";
import { isMethod, uid } from "./factory.ts";
import { lookup } from "./jsonpath.ts";
import { runScript, type ScriptOutcome, type ScriptRequestState, type ScriptResponseState } from "./script.ts";
import type { HttpSender } from "./ports.ts";
import type { AssertionResult, ExecutionResult, Pair, RequestModel, ScriptHook } from "./types.ts";
import { collectPlaceholders, diffRecords, interpolate } from "./variables.ts";

export const MAX_BODY_BYTES = 1024 * 1024;

/** Default del puerto `HttpSender`: el emisor que usan todos los hosts. */
const defaultSender: HttpSender = (url, init) => fetch(url, init);

/** Hooks externos, capa ambiente y loader de módulos que un host adjunta al paso. */
export type ScriptBinding = {
  /** Corren antes del script de la petición, en orden (ambiente, colección). */
  pre?: ScriptHook[];
  /** Corren después del script de la petición, en orden (colección, ambiente). */
  post?: ScriptHook[];
  /** Copia de la capa ambiente; los cambios vuelven como `environmentChanged`. */
  environment?: Record<string, string>;
  /** `omnium.require` en hosts con Node; sin loader el script recibe un error claro. */
  require?: (specifier: string) => unknown;
};

export type PreparedRequest = {
  url: string;
  method: RequestModel["method"];
  headers: [string, string][];
  body?: string;
  missing: string[];
  error: string | null;
  hostname: string;
};

export async function executeRequest(options: {
  request: RequestModel;
  variables: Record<string, string>;
  jar?: CookieJar;
  persistCookies?: boolean;
  captureBody?: boolean;
  signal?: AbortSignal;
  /** Hooks de script (ambiente/colección), su capa ambiente y el loader de módulos. */
  scripts?: ScriptBinding;
  /** Puerto de salida HTTP; default: `fetch` global. */
  send?: HttpSender;
}): Promise<ExecutionResult> {
  const began = performance.now();
  const scripts = options.scripts;
  const send = options.send ?? defaultSender;
  const initialVariables = options.variables;
  const state: ScriptState = {
    logs: [],
    tests: [],
    variables: { ...options.variables },
    environment: { ...(scripts?.environment ?? {}) },
  };
  let request = options.request;

  // Pre: primero los hooks externos (ambiente, colección) y al final el de la
  // petición, para que su `omnium.request` vea lo que los otros ya prepararon.
  const preHooks = [
    ...(scripts?.pre ?? []).map((hook) => ({ ...hook, external: true })),
    ...(request.preScript?.trim()
      ? [{ label: "script de la petición", code: request.preScript, external: false }]
      : []),
  ];
  for (const hook of preHooks) {
    const outcome = await runScript(hook.code, {
      phase: "pre",
      variables: state.variables,
      environment: state.environment,
      request: toScriptRequest(request),
      require: scripts?.require,
    });
    absorb(state, outcome, hook.label, hook.external, false);
    if (outcome.request) request = applyScriptRequest(request, toScriptRequest(request), outcome.request);
    if (!outcome.ok) {
      return {
        ...emptyResult(request, request.url, []),
        error: `${hook.label}: ${outcome.error}`,
        timeMs: elapsed(began),
        assertions: renumberTests(state.tests),
        extracted: diffRecords(initialVariables, state.variables),
        ...scriptEffects(scripts, state),
      };
    }
  }

  const started = performance.now();
  const prepared = prepareRequest(request, state.variables, options.jar);
  const base = emptyResult(request, prepared.url || request.url, prepared.missing);

  if (prepared.error || !prepared.url) {
    return {
      ...base,
      error: prepared.error ?? "La URL está vacía",
      timeMs: elapsed(started),
      assertions: renumberTests(state.tests),
      extracted: diffRecords(initialVariables, state.variables),
      ...scriptEffects(scripts, state),
    };
  }

  const timeoutMs = clamp(options.request.timeoutMs, 50, 120000);
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  try {
    const response = await send(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      redirect: options.request.followRedirects ? "follow" : "manual",
      cache: "no-store",
      signal,
    });
    const cookieUrl = safeUrl(response.url) ?? safeUrl(prepared.url);
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (options.jar && options.persistCookies !== false && cookieUrl) options.jar.absorb(cookieUrl, setCookies);

    const captured = options.captureBody !== false;
    let buffer = new ArrayBuffer(0);
    let truncated = false;
    try {
      if (!captured) await response.body?.cancel().catch(() => undefined);
      else {
        const read = await readLimitedBody(response, MAX_BODY_BYTES);
        buffer = read.buffer;
        truncated = read.truncated;
      }
    } catch (error) {
      const partial = {
        ...base,
        url: prepared.url,
        finalUrl: response.url || prepared.url,
        status: response.status,
        statusText: response.statusText,
        timeMs: elapsed(started),
        headers: collectHeaders(response),
      };
      if (options.signal?.aborted) return { ...partial, error: "Petición cancelada" };
      if (signal.aborted) return { ...partial, error: "La petición superó el tiempo límite" };
      throw error;
    }

    const type = response.headers.get("content-type") ?? "";
    const binary = captured ? isBinary(type, buffer) : false;
    const bodyText = !captured || binary ? (binary ? `Contenido binario (${buffer.byteLength} bytes)` : "") : decodeText(buffer);
    const bodyJson = binary || !captured ? null : parseJson(bodyText);
    const headers = collectHeaders(response);
    const declared = Number(response.headers.get("content-length") ?? "");
    const partial = {
      status: response.status,
      timeMs: elapsed(started),
      headers,
      bodyText,
      bodyJson,
    };
    const assertions = evaluateAssertions(partial, request.assertions);
    const extracted = extractValues(request, partial);

    // Post: primero el de la petición y después los externos (colección,
    // ambiente), para que los últimos vean lo que los anteriores dejaron.
    const postHooks = [
      ...(request.postScript?.trim()
        ? [{ label: "script de la petición", code: request.postScript, external: false }]
        : []),
      ...(scripts?.post ?? []).map((hook) => ({ ...hook, external: true })),
    ];
    for (const hook of postHooks) {
      const outcome = await runScript(hook.code, {
        phase: "post",
        variables: state.variables,
        environment: state.environment,
        response: toScriptResponse(partial),
        require: scripts?.require,
      });
      // Un error en post no borra la respuesta: queda como aserción fallida.
      absorb(state, outcome, hook.label, hook.external, true);
    }

    const done: ExecutionResult = {
      ...base,
      ok: false,
      error: null,
      url: prepared.url,
      finalUrl: response.url || prepared.url,
      status: response.status,
      statusText: response.statusText,
      timeMs: partial.timeMs,
      sizeBytes: captured ? buffer.byteLength : Number.isFinite(declared) ? declared : 0,
      headers,
      bodyText,
      bodyJson,
      binary,
      truncated,
      assertions: renumberTests([...assertions, ...state.tests]),
      extracted: { ...extracted, ...diffRecords(initialVariables, state.variables) },
      ...scriptEffects(scripts, state),
    };
    return { ...done, ok: stepPassed(done) };
  } catch (error) {
    return {
      ...base,
      error: failureMessage(error, options.signal),
      timeMs: elapsed(started),
      url: prepared.url,
      assertions: renumberTests(state.tests),
      extracted: diffRecords(initialVariables, state.variables),
      ...scriptEffects(scripts, state),
    };
  }
}

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

export function prepareRequest(
  request: RequestModel,
  variables: Record<string, string>,
  jar?: CookieJar,
): PreparedRequest {
  const missing = collectPlaceholders(request).filter((name) => !Object.prototype.hasOwnProperty.call(variables, name));
  const rawUrl = interpolate(request.url, variables).replace(/[\r\n\0]/g, "").trim();
  if (missing.length) {
    return { url: rawUrl, method: request.method, headers: [], missing, error: `Faltan variables: ${missing.join(", ")}`, hostname: "" };
  }
  if (!rawUrl) {
    return { url: "", method: request.method, headers: [], missing, error: "La URL está vacía", hostname: "" };
  }

  let url: URL;
  try {
    url = new URL(normalizeUrl(rawUrl));
  } catch {
    return { url: rawUrl, method: request.method, headers: [], missing, error: "La URL no es válida", hostname: "" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      url: url.toString(),
      method: request.method,
      headers: [],
      missing,
      error: "Solo se permiten direcciones http y https",
      hostname: "",
    };
  }

  for (const param of request.params) {
    if (!param.enabled || !param.key.trim()) continue;
    url.searchParams.append(cleanField(interpolate(param.key, variables)), cleanField(interpolate(param.value, variables)));
  }

  const headers = new Map<string, string>();
  for (const header of request.headers) {
    if (!header.enabled || !header.key.trim()) continue;
    const name = cleanField(header.key);
    if (!name) continue;
    headers.set(name, cleanField(interpolate(header.value, variables)));
  }

  const authError = applyAuth(request, variables, url, headers);
  if (authError) {
    return { url: url.toString(), method: request.method, headers: [...headers], missing, error: authError, hostname: url.hostname };
  }

  if (!hasHeader(headers, "accept")) headers.set("Accept", "*/*");
  if (!hasHeader(headers, "user-agent")) headers.set("User-Agent", "Omnium/0.1");

  const cookie = jar?.headerFor(url);
  if (cookie && !hasHeader(headers, "cookie")) headers.set("Cookie", cookie);

  const canBody = request.method !== "GET" && request.method !== "HEAD";
  let body: string | undefined;
  if (canBody && request.bodyMode === "json") {
    const raw = interpolate(request.bodyRaw, variables);
    if (!raw.trim()) {
      return { url: url.toString(), method: request.method, headers: [...headers], missing, error: "El cuerpo JSON está vacío", hostname: url.hostname };
    }
    try {
      JSON.parse(raw);
    } catch {
      return { url: url.toString(), method: request.method, headers: [...headers], missing, error: "El cuerpo JSON no es válido", hostname: url.hostname };
    }
    body = raw;
    if (!hasHeader(headers, "content-type")) headers.set("Content-Type", "application/json");
  } else if (canBody && request.bodyMode === "text") {
    body = interpolate(request.bodyRaw, variables);
    if (!hasHeader(headers, "content-type")) headers.set("Content-Type", "text/plain; charset=utf-8");
  } else if (canBody && request.bodyMode === "form") {
    const params = new URLSearchParams();
    for (const row of request.form) {
      if (!row.enabled || !row.key.trim()) continue;
      params.append(cleanField(interpolate(row.key, variables)), interpolate(row.value, variables));
    }
    body = params.toString();
    if (!hasHeader(headers, "content-type")) headers.set("Content-Type", "application/x-www-form-urlencoded");
  }

  return {
    url: url.toString(),
    method: request.method,
    headers: [...headers.entries()],
    body,
    missing,
    error: null,
    hostname: url.hostname,
  };
}

export function toCurl(request: RequestModel, variables: Record<string, string>): string {
  const prepared = prepareRequest(request, variables);
  const lines = [`curl -X ${prepared.method} ${shellQuote(prepared.url || request.url)}`];
  for (const [key, value] of prepared.headers) {
    if (key.toLowerCase() === "accept" && value === "*/*") continue;
    if (key.toLowerCase() === "user-agent" && value.startsWith("Omnium/")) continue;
    lines.push(`  -H ${shellQuote(`${key}: ${value}`)}`);
  }
  if (prepared.body) lines.push(`  --data-raw ${shellQuote(prepared.body)}`);
  const command = lines.join(" \\\n");
  return prepared.error ? `# ${prepared.error}\n${command}` : command;
}

function applyAuth(
  request: RequestModel,
  variables: Record<string, string>,
  url: URL,
  headers: Map<string, string>,
): string | null {
  const auth = request.auth;
  if (auth.type === "none") return null;
  if (auth.type === "bearer") {
    const token = cleanField(interpolate(auth.token, variables));
    if (!token) return "Falta el token de Bearer";
    deleteHeader(headers, "authorization");
    headers.set("Authorization", `Bearer ${token}`);
    return null;
  }
  if (auth.type === "basic") {
    const username = interpolate(auth.username, variables);
    const password = interpolate(auth.password, variables);
    deleteHeader(headers, "authorization");
    headers.set("Authorization", `Basic ${encodeBase64(`${username}:${password}`)}`);
    return null;
  }
  const key = cleanField(interpolate(auth.key, variables));
  const value = cleanField(interpolate(auth.value, variables));
  if (!key) return "Falta el nombre de la clave de API";
  if (auth.in === "query") url.searchParams.append(key, value);
  else {
    deleteHeader(headers, key);
    headers.set(key, value);
  }
  return null;
}

function extractValues(
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

/** Estado que los scripts van dejando a lo largo de un paso. */
type ScriptState = {
  logs: string[];
  tests: AssertionResult[];
  variables: Record<string, string>;
  environment: Record<string, string>;
};

/** Fusiona lo que un script dejó: logs, tests, variables y capa ambiente. */
function absorb(
  state: ScriptState,
  outcome: ScriptOutcome,
  label: string,
  external: boolean,
  asFailure: boolean,
): void {
  const prefix = external ? `${label}: ` : "";
  for (const line of outcome.logs) state.logs.push(prefix + line);
  for (const test of outcome.tests) state.tests.push({ ...test, message: `${prefix}${test.message}` });
  Object.assign(state.variables, outcome.variables);
  Object.assign(state.environment, outcome.environment);
  if (!outcome.ok && asFailure) state.tests.push({ id: "script:0", passed: false, message: `${label}: ${outcome.error}` });
}

/** Los tests de todos los scripts se renumeran al final: `script:1..n` en orden. */
function renumberTests(tests: AssertionResult[]): AssertionResult[] {
  let counter = 0;
  return tests.map((test) => (test.id.startsWith("script:") ? { ...test, id: `script:${++counter}` } : test));
}

function scriptEffects(scripts: ScriptBinding | undefined, state: ScriptState): Partial<ExecutionResult> {
  const changed = diffRecords(scripts?.environment ?? {}, state.environment);
  return {
    ...(state.logs.length ? { logs: state.logs } : {}),
    ...(Object.keys(changed).length ? { environmentChanged: changed } : {}),
  };
}

/** Estado que ve el script en fase pre: valores crudos, sin interpolar, para
 * que los campos que no toca conserven sus `{{...}}`. */
function toScriptRequest(request: RequestModel): ScriptRequestState {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers.filter((row) => row.enabled).map((row) => ({ name: row.key, value: row.value })),
    body: request.bodyMode === "json" || request.bodyMode === "text" ? request.bodyRaw : "",
  };
}

/** Aplica solo lo que el script cambió; lo intocado se queda como estaba. */
function applyScriptRequest(current: RequestModel, before: ScriptRequestState, after: ScriptRequestState): RequestModel {
  const next: RequestModel = { ...current };
  if (after.url !== before.url) next.url = after.url;
  if (after.method !== before.method && isMethod(after.method.trim().toUpperCase())) {
    next.method = after.method.trim().toUpperCase() as RequestModel["method"];
  }
  if (after.body !== before.body && (current.bodyMode === "json" || current.bodyMode === "text")) next.bodyRaw = after.body;
  if (JSON.stringify(after.headers) !== JSON.stringify(before.headers)) {
    next.headers = mergeHeaders(current.headers, after.headers);
  }
  return next;
}

/** Reconstruye los headers habilitados desde la lista del script: conserva
 * id/secreto por nombre, respeta las filas deshabilitadas y agrega las nuevas. */
function mergeHeaders(current: Pair[], next: { name: string; value: string }[]): Pair[] {
  const pending = new Map(next.map((header) => [header.name.trim().toLowerCase(), header]));
  const out: Pair[] = [];
  for (const row of current) {
    if (!row.enabled) {
      out.push(row);
      continue;
    }
    const hit = pending.get(row.key.trim().toLowerCase());
    if (!hit) continue;
    pending.delete(row.key.trim().toLowerCase());
    out.push(hit.value === row.value ? row : { ...row, value: hit.value });
  }
  for (const header of pending.values()) {
    out.push({ id: uid("pair"), key: header.name, value: header.value, enabled: true });
  }
  return out;
}

function toScriptResponse(partial: {
  status: number;
  timeMs: number;
  headers: { name: string; value: string }[];
  bodyText: string;
  bodyJson: unknown | null;
}): ScriptResponseState {
  return { status: partial.status, timeMs: partial.timeMs, headers: partial.headers, bodyText: partial.bodyText, bodyJson: partial.bodyJson };
}

function emptyResult(request: RequestModel, url: string, missing: string[]): ExecutionResult {
  return {
    ok: false,
    error: null,
    requestId: request.id,
    name: request.name,
    method: request.method,
    url,
    finalUrl: url,
    status: null,
    statusText: "",
    timeMs: 0,
    sizeBytes: 0,
    headers: [],
    bodyText: "",
    bodyJson: null,
    binary: false,
    truncated: false,
    assertions: [],
    extracted: {},
    missing,
  };
}

function collectHeaders(response: Response): { name: string; value: string }[] {
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

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function isBinary(type: string, buffer: ArrayBuffer): boolean {
  if (/json|text|xml|javascript|svg|x-www-form-urlencoded|\+json/.test(type)) return false;
  if (!type) {
    const sample = new Uint8Array(buffer.slice(0, 32));
    return sample.some((byte) => byte === 0);
  }
  return true;
}

function decodeText(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

function normalizeUrl(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function hasHeader(headers: Map<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  for (const key of headers.keys()) if (key.toLowerCase() === target) return true;
  return false;
}

function deleteHeader(headers: Map<string, string>, name: string): void {
  const target = name.toLowerCase();
  for (const key of [...headers.keys()]) if (key.toLowerCase() === target) headers.delete(key);
}

function cleanField(value: string): string {
  return value.replace(/[\r\n\0]/g, "").trim();
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function safeUrl(value: string): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function failureMessage(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return "Petición cancelada";
  if (isTimeout(error)) return "La petición superó el tiempo límite";
  const code = errorCode(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "No se encontró el servidor";
  if (code === "ECONNREFUSED") return "El servidor rechazó la conexión";
  if (code === "ECONNRESET" || code === "EPIPE") return "La conexión se cortó";
  if (code.startsWith("CERT_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return "Falló el certificado TLS";
  }
  if (error instanceof Error && error.message && error.message !== "fetch failed") return error.message;
  return "No se pudo conectar";
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  if (error.name === "TimeoutError") return true;
  if (error.name === "AbortError" && "cause" in error && isTimeout(error.cause)) return true;
  return error.name === "AbortError";
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return errorCode(error.cause);
  return "";
}
