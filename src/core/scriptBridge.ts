import { isMethod, uid } from "./factory.ts";
import type { ScriptOutcome, ScriptRequestState, ScriptResponseState } from "./script.ts";
import type { AssertionResult, ExecutionResult, Pair, RequestModel, ScriptHook } from "./types.ts";
import { diffRecords } from "./variables.ts";

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

/** Estado que los scripts van dejando a lo largo de un paso. */
export type ScriptState = {
  logs: string[];
  tests: AssertionResult[];
  variables: Record<string, string>;
  environment: Record<string, string>;
};

export function createScriptState(variables: Record<string, string>, environment: Record<string, string>): ScriptState {
  return { logs: [], tests: [], variables: { ...variables }, environment: { ...environment } };
}

/** Fusiona lo que un script dejó: logs, tests, variables y capa ambiente. */
export function absorb(
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
export function renumberTests(tests: AssertionResult[]): AssertionResult[] {
  let counter = 0;
  return tests.map((test) => (test.id.startsWith("script:") ? { ...test, id: `script:${++counter}` } : test));
}

/** Efectos del paso: logs y cambios de la capa ambiente, solo si los hay. */
export function scriptEffects(scripts: ScriptBinding | undefined, state: ScriptState): Partial<ExecutionResult> {
  const changed = diffRecords(scripts?.environment ?? {}, state.environment);
  return {
    ...(state.logs.length ? { logs: state.logs } : {}),
    ...(Object.keys(changed).length ? { environmentChanged: changed } : {}),
  };
}

/** Estado que ve el script en fase pre: valores crudos, sin interpolar, para
 * que los campos que no toca conserven sus `{{...}}`. */
export function toScriptRequest(request: RequestModel): ScriptRequestState {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers.filter((row) => row.enabled).map((row) => ({ name: row.key, value: row.value })),
    body: request.bodyMode === "json" || request.bodyMode === "text" ? request.bodyRaw : "",
  };
}

/** Aplica solo lo que el script cambió; lo intocado se queda como estaba. */
export function applyScriptRequest(current: RequestModel, before: ScriptRequestState, after: ScriptRequestState): RequestModel {
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

export function toScriptResponse(partial: {
  status: number;
  timeMs: number;
  headers: { name: string; value: string }[];
  bodyText: string;
  bodyJson: unknown | null;
}): ScriptResponseState {
  return { status: partial.status, timeMs: partial.timeMs, headers: partial.headers, bodyText: partial.bodyText, bodyJson: partial.bodyJson };
}
