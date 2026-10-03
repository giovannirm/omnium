import type { ScriptRequestState, ScriptResponseState } from "./script.ts";

/**
 * Puente compatible con la API de scripts de Postman (`pm.*`).
 *
 * Subconjunto real observado en colecciones: `pm.test`, `pm.expect` (chai),
 * `pm.environment` / `pm.variables`, `pm.response` (status/header/json/ok),
 * `pm.request` y el alias legacy `postman`. Lo que no entra en el subconjunto
 * falla en runtime con el error del motor, nunca en silencio.
 */

export type PmScope = {
  test: (name: unknown, check: unknown) => Promise<void>;
  log: (...args: unknown[]) => void;
  variables: { get: (key: string) => string; set: (key: string, value: unknown) => void };
  environment: { get: (key: string) => string; set: (key: string, value: unknown) => void };
  request?: ScriptRequestState;
  response?: ScriptResponseState;
};

type Node = Record<string, unknown> & { to: Node; be: Node; have: Node; and: Node };

export function createPm(scope: PmScope): Record<string, unknown> {
  const { variables, environment } = scope;

  const replaceIn = (text: string): string =>
    String(text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => environment.get(key) || variables.get(key));

  const pm: Record<string, unknown> = {
    test: scope.test,
    log: scope.log,
    expect: (actual: unknown) => chain(false, actual),
    variables: {
      get: variables.get,
      set: variables.set,
      has: (key: unknown) => variables.get(String(key)) !== "",
      unset: (key: unknown) => variables.set(String(key), ""),
      replaceIn,
    },
    environment: {
      get: environment.get,
      set: environment.set,
      has: (key: unknown) => environment.get(String(key)) !== "",
      unset: (key: unknown) => environment.set(String(key), ""),
      replaceIn,
    },
    info: {},
  };

  if (scope.request) pm.request = wrapRequest(scope.request);
  if (scope.response) pm.response = wrapResponse(scope.response);

  return pm;
}

/** Alias legacy `postman.*`: los nombres viejos apuntan al mismo estado. */
export function createPostmanLegacy(pm: Record<string, unknown>): Record<string, unknown> {
  const environment = pm.environment as { get: (k: string) => string; set: (k: string, v: unknown) => void };
  const variables = pm.variables as { get: (k: string) => string; set: (k: string, v: unknown) => void };
  return {
    ...pm,
    setEnvironmentVariable: environment.set,
    getEnvironmentVariable: environment.get,
    clearEnvironmentVariable: (key: unknown) => environment.set(String(key), ""),
    setGlobalVariable: variables.set,
    getGlobalVariable: variables.get,
    clearGlobalVariable: (key: unknown) => variables.set(String(key), ""),
    getResponseHeader: (name: unknown) => (pm.response as { headers?: { get: (n: string) => string } } | undefined)?.headers?.get(String(name)) ?? null,
  };
}

function wrapRequest(request: ScriptRequestState): Record<string, unknown> {
  const find = (name: string) => request.headers.find((row) => row.name.toLowerCase() === name.toLowerCase());
  return {
    method: request.method,
    url: request.url,
    body: request.body,
    headers: {
      get: (name: unknown) => find(String(name))?.value ?? null,
      has: (name: unknown) => find(String(name)) !== undefined,
      all: () => request.headers.map((row) => ({ key: row.name, value: row.value })),
    },
    getHeader: (name: unknown) => find(String(name))?.value ?? null,
    addHeader: (name: unknown, value: unknown) => {
      const key = String(name);
      const found = find(key);
      if (found) found.value = String(value);
      else request.headers.push({ name: key, value: String(value) });
    },
    removeHeader: (name: unknown) => {
      const key = String(name).toLowerCase();
      const at = request.headers.findIndex((row) => row.name.toLowerCase() === key);
      if (at >= 0) request.headers.splice(at, 1);
    },
  };
}

function wrapResponse(response: ScriptResponseState): Record<string, unknown> {
  const json = (): unknown => {
    try {
      return JSON.parse(response.bodyText) as unknown;
    } catch {
      throw new Error("La respuesta no es JSON válido");
    }
  };
  const statusIs = (code: string | number): boolean => {
    const text = String(code);
    const match = /^(\d)x(\d)?$/i.exec(text);
    if (match) return Math.floor(response.status / 100) === Number(text[0]);
    return response.status === Number(text);
  };
  const fail = (detail: string): never => {
    throw new Error(detail);
  };
  return {
    code: response.status,
    status: response.status,
    time: response.timeMs,
    size: response.bodyText.length,
    text: response.bodyText,
    json,
    headers: {
      get: (name: unknown) => header(response, String(name)),
      has: (name: unknown) => header(response, String(name)) !== null,
      all: () => response.headers.map((row) => ({ key: row.name, value: row.value })),
    },
    to: {
      have: {
        status(code: unknown) {
          if (!statusIs(String(code))) fail(`esperaba status ${String(code)}, llegó ${response.status}`);
        },
        header(name: unknown, value?: unknown) {
          const found = header(response, String(name));
          if (found === null) fail(`la respuesta no tiene el header ${String(name)}`);
          if (value !== undefined && found !== String(value)) {
            fail(`esperaba el header ${String(name)} con ${String(value)}, llegó ${found}`);
          }
        },
        json() {
          json();
        },
      },
      be: {
        get ok() {
          if (response.status < 200 || response.status > 299) fail(`esperaba 2xx, llegó ${response.status}`);
          return true;
        },
        get json() {
          json();
          return true;
        },
        oneOf(...codes: unknown[]) {
          if (!codes.some((code) => statusIs(String(code)))) {
            fail(`esperaba uno de [${codes.join(", ")}], llegó ${response.status}`);
          }
        },
      },
      not: {
        have: {
          status(code: unknown) {
            if (statusIs(String(code))) fail(`no esperaba status ${String(code)}`);
          },
          header(name: unknown) {
            if (header(response, String(name)) !== null) fail(`no esperaba el header ${String(name)}`);
          },
        },
      },
    },
  };
}

function header(response: ScriptResponseState, name: string): string | null {
  const found = response.headers.find((row) => row.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : null;
}

/** Cadena estilo chai: `.to`, `.be`, `.have`, `.and`, `.not` encadenan sin consumir. */
function chain(negated: boolean, actual: unknown): Node {
  const show = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const verify = (pass: boolean, detail: string): void => {
    const ok = negated ? !pass : pass;
    if (!ok) throw new Error(`${negated ? "no " : ""}${detail} (llegó ${show(actual)})`);
  };
  const same = (expected: unknown): boolean => same2(actual, expected);
  const includes = (part: unknown): boolean => {
    if (Array.isArray(actual)) return actual.some((row) => same2(row, part));
    const text = typeof actual === "string" ? actual : show(actual);
    return text.includes(String(part));
  };
  const size = (): number => {
    if (Array.isArray(actual) || typeof actual === "string") return actual.length;
    return -1;
  };

  const node = {
    get not() {
      return chain(!negated, actual);
    },
    get true() {
      verify(actual === true, "esperaba true");
      return node;
    },
    get false() {
      verify(actual === false, "esperaba false");
      return node;
    },
    get null() {
      verify(actual === null, "esperaba null");
      return node;
    },
    get undefined() {
      verify(actual === undefined, "esperaba undefined");
      return node;
    },
    get ok() {
      verify(Boolean(actual), "esperaba truthy");
      return node;
    },
    get json() {
      try {
        JSON.parse(typeof actual === "string" ? actual : show(actual));
        verify(true, "esperaba JSON");
      } catch {
        verify(false, "esperaba JSON");
      }
      return node;
    },
    equal(expected: unknown) {
      verify(actual === expected, `esperaba ${show(expected)}`);
      return node;
    },
    eql(expected: unknown) {
      verify(same(expected), `esperaba ${show(expected)}`);
      return node;
    },
    include(part: unknown) {
      verify(includes(part), `esperaba incluir ${show(part)}`);
      return node;
    },
    contain(part: unknown) {
      verify(includes(part), `esperaba contener ${show(part)}`);
      return node;
    },
    property(name: unknown, value?: unknown) {
      const key = String(name);
      const record = actual && typeof actual === "object" ? (actual as Record<string, unknown>) : {};
      const has = key in record;
      verify(has, `esperaba la propiedad ${key}`);
      if (has && value !== undefined) verify(same2(record[key], value), `esperaba ${key} = ${show(value)}`);
      return node;
    },
    oneOf(list: unknown) {
      const options = Array.isArray(list) ? list : [list];
      verify(options.some((option) => same2(actual, option)), `esperaba uno de ${show(options)}`);
      return node;
    },
    match(pattern: unknown) {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
      verify(regex.test(typeof actual === "string" ? actual : show(actual)), `esperaba cumplir ${regex}`);
      return node;
    },
    above(limit: unknown) {
      verify(Number(actual) > Number(limit), `esperaba ser mayor que ${String(limit)}`);
      return node;
    },
    below(limit: unknown) {
      verify(Number(actual) < Number(limit), `esperaba ser menor que ${String(limit)}`);
      return node;
    },
    least(limit: unknown) {
      verify(Number(actual) >= Number(limit), `esperaba ser al menos ${String(limit)}`);
      return node;
    },
    most(limit: unknown) {
      verify(Number(actual) <= Number(limit), `esperaba ser como mucho ${String(limit)}`);
      return node;
    },
    length(expected: unknown) {
      verify(size() === Number(expected), `esperaba longitud ${String(expected)}`);
      return node;
    },
    lengthOf(expected: unknown) {
      verify(size() === Number(expected), `esperaba longitud ${String(expected)}`);
      return node;
    },
  } as unknown as Node;

  node.to = node;
  node.be = node;
  node.have = node;
  node.and = node;
  node.deep = node;
  return node;
}

/** Comparación usada por `property(name, value)` y `oneOf`: JSON estable. */
function same2(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  try {
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
