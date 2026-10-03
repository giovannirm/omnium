import type { AssertionResult } from "./types.ts";
import { createPostmanLegacy, createPm } from "./pm.ts";

export type ScriptPhase = "pre" | "post";

export type ScriptRequestState = {
  method: string;
  url: string;
  headers: { name: string; value: string }[];
  body: string;
};

export type ScriptResponseState = {
  status: number;
  timeMs: number;
  headers: { name: string; value: string }[];
  bodyText: string;
  bodyJson: unknown | null;
};

export type ScriptOptions = {
  phase: ScriptPhase;
  /** Capa runtime: se lee y se escribe; lo escrito vuelve como `extracted`. */
  variables: Record<string, string>;
  /** Copia de las variables del ambiente; lo escrito vuelve como `environmentChanged`. */
  environment?: Record<string, string>;
  /** Estado de la petición, solo en fase pre. */
  request?: ScriptRequestState;
  /** Estado de la respuesta, solo en fase post. */
  response?: ScriptResponseState;
  /** Inyectado por los hosts con Node; en web no existe y `omnium.require` avisa. */
  require?: (specifier: string) => unknown;
  timeoutMs?: number;
};

export type ScriptOutcome = {
  ok: boolean;
  error: string | null;
  logs: string[];
  tests: AssertionResult[];
  variables: Record<string, string>;
  environment: Record<string, string>;
  request?: ScriptRequestState;
};

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Ejecuta un script de usuario en su propia fase.
 *
 * Corre siempre en un host con JS: se usa `new Function` (no `node:vm`) porque
 * este módulo también se empaqueta en el renderer. El código va envuelto en una
 * función async, así que admite `await` de nivel superior. El deadline cubre
 * esperas async; una fuga sincrónica bloqueante no se puede cortar desde JS —
 * documentado como límite del modelo.
 */
export async function runScript(code: string, options: ScriptOptions): Promise<ScriptOutcome> {
  const variables = { ...options.variables };
  const environment = { ...(options.environment ?? {}) };
  const logs: string[] = [];
  const tests: AssertionResult[] = [];
  const request = options.request ? cloneRequest(options.request) : undefined;

  const base = (): Omit<ScriptOutcome, "ok" | "error"> => ({
    logs,
    tests,
    variables,
    environment,
    ...(request ? { request } : {}),
  });

  if (!code.trim()) return { ok: true, error: null, ...base() };

  /** Reserva el lugar en orden de llamada; el resultado se completa después. */
  const running: Promise<void>[] = [];
  const omnium = {
    log: (...args: unknown[]) => {
      logs.push(args.map((item) => show(item)).join(" "));
    },
    variables: {
      get: (key: string) => variables[String(key)] ?? "",
      set: (key: string, value: unknown) => {
        variables[String(key)] = String(value);
      },
    },
    env: {
      get: (key: string) => environment[String(key)] ?? "",
      set: (key: string, value: unknown) => {
        environment[String(key)] = String(value);
      },
    },
    test: (name: unknown, check: unknown): Promise<void> => {
      const label = String(name);
      const slot: AssertionResult = { id: `script:${tests.length + 1}`, passed: false, message: label };
      tests.push(slot);
      const run = (async () => {
        if (typeof check !== "function") {
          slot.passed = false;
          slot.message = `${label} — el segundo argumento debe ser una función`;
          return;
        }
        try {
          await check();
          slot.passed = true;
        } catch (error) {
          slot.passed = false;
          slot.message = `${label} — ${message(error)}`;
        }
      })();
      running.push(run);
      return run;
    },
    expect: (actual: unknown) => makeExpect(actual),
    sleep: (ms: unknown) => new Promise((resolve) => setTimeout(resolve, clampMs(ms))),
    request,
    response: options.response,
    require: (specifier: unknown) => {
      if (!options.require) {
        throw new Error(
          `omnium.require("${String(specifier)}") necesita la app de escritorio o la CLI con un área abierta en disco`,
        );
      }
      return options.require(String(specifier));
    },
  };

  /** Puente Postman: mismo estado que `omnium`, API `pm.*` para colecciones importadas. */
  const pm = createPm({
    test: omnium.test,
    log: omnium.log,
    variables: omnium.variables,
    environment: omnium.env,
    ...(request ? { request } : {}),
    ...(options.response ? { response: options.response } : {}),
  });
  const postmanLegacy = createPostmanLegacy(pm);

  try {
    const runner = new Function(
      "omnium",
      "pm",
      "postman",
      `"use strict";\nreturn (async () => {\n${code}\n})();`,
    ) as (
      scope: typeof omnium,
      pmScope: Record<string, unknown>,
      legacyScope: Record<string, unknown>,
    ) => Promise<unknown>;
    await withDeadline(runner(omnium, pm, postmanLegacy), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await Promise.all(running);
    return { ok: true, error: null, ...base() };
  } catch (error) {
    await Promise.all(running).catch(() => undefined);
    return { ok: false, error: message(error), ...base() };
  }
}

function withDeadline(work: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`El script pasó de ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function cloneRequest(request: ScriptRequestState): ScriptRequestState {
  return { ...request, headers: request.headers.map((item) => ({ ...item })) };
}

function clampMs(value: unknown): number {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(ms, 0), 5000);
}

function show(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `expect` propio: sin dependencias, errores en castellano para la UI. */
function makeExpect(actual: unknown) {
  const fail = (detail: string): never => {
    throw new Error(`${detail} (esperaba ${show(actual)})`);
  };
  return {
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) fail(`esperaba ${show(expected)}, llegó ${show(actual)}`);
    },
    toEqual(expected: unknown) {
      if (show(actual) !== show(expected)) fail(`esperaba ${show(expected)}, llegó ${show(actual)}`);
    },
    toBeTruthy() {
      if (!actual) fail("esperaba algo verdadero");
    },
    toBeFalsy() {
      if (actual) fail("esperaba algo falso");
    },
    toBeDefined() {
      if (actual === undefined) fail("esperaba un valor definido");
    },
    toContain(part: unknown) {
      const text = typeof actual === "string" ? actual : show(actual);
      if (!text.includes(String(part))) fail(`esperaba contener ${show(part)}`);
    },
    toMatch(pattern: unknown) {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
      if (!regex.test(typeof actual === "string" ? actual : show(actual))) fail(`esperaba cumplir ${regex}`);
    },
    toBeLessThan(limit: unknown) {
      if (!(Number(actual) < Number(limit))) fail(`esperaba ser menor que ${show(limit)}`);
    },
    toBeGreaterThan(limit: unknown) {
      if (!(Number(actual) > Number(limit))) fail(`esperaba ser mayor que ${show(limit)}`);
    },
  };
}

/** Hooks externos de una corrida: el ambiente abre (pre) y cierra (post),
 * la colección va por dentro. Es la misma composición que usan CLI y UI. */
export function externalHooks(
  collection: { preScript?: string; postScript?: string } | null | undefined,
  environment: { preScript?: string; postScript?: string } | null | undefined,
): { pre?: { label: string; code: string }[]; post?: { label: string; code: string }[] } {
  const pre: { label: string; code: string }[] = [];
  const post: { label: string; code: string }[] = [];
  if (environment?.preScript?.trim()) pre.push({ label: "ambiente", code: environment.preScript });
  if (collection?.preScript?.trim()) pre.push({ label: "colección", code: collection.preScript });
  if (collection?.postScript?.trim()) post.push({ label: "colección", code: collection.postScript });
  if (environment?.postScript?.trim()) post.push({ label: "ambiente", code: environment.postScript });
  return { ...(pre.length ? { pre } : {}), ...(post.length ? { post } : {}) };
}
