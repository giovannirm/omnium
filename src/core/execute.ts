import { evaluateAssertions, stepPassed } from "./assertions.ts";
import { CookieJar } from "./cookies.ts";
import {
  MAX_BODY_BYTES,
  collectHeaders,
  decodeText,
  extractValues,
  isBinary,
  parseJson,
  readLimitedBody,
  sendPrepared,
} from "./http.ts";
import type { HttpSender } from "./ports.ts";
import { prepareRequest } from "./prepare.ts";
import { runScript } from "./script.ts";
import {
  absorb,
  applyScriptRequest,
  createScriptState,
  renumberTests,
  scriptEffects,
  toScriptRequest,
  toScriptResponse,
  type ScriptBinding,
} from "./scriptBridge.ts";
import type { ExecutionResult, RequestModel } from "./types.ts";
import { diffRecords } from "./variables.ts";

// Fachada: los consumidores existentes (engine, runner, snippets, UI, tests)
// siguen importando estos símbolos desde `./execute.ts`.
export { MAX_BODY_BYTES, readLimitedBody } from "./http.ts";
export { prepareRequest, toCurl } from "./prepare.ts";
export type { PreparedRequest } from "./prepare.ts";
export type { ScriptBinding };

/** Default del puerto `HttpSender`: el emisor que usan todos los hosts. */
const defaultSender: HttpSender = (url, init) => fetch(url, init);

/** Orquesta un paso completo: scripts pre → preparar → enviar por el puerto →
 * parsear → aserciones/extractores → scripts post. Nunca lanza: los fallos
 * vuelven dentro del `ExecutionResult`. */
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
  const state = createScriptState(options.variables, scripts?.environment ?? {});
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
    const response = await sendPrepared(send, prepared, options.request.followRedirects, signal);
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

function safeUrl(value: string): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
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
