import { createRequest, isMethod, pair, uid } from "./factory.ts";
import type { ImportResult } from "./interchange.ts";
import type { Auth, Collection, Pair, RequestModel } from "./types.ts";

type Ctx = { auth?: unknown; pre?: string; post?: string };

/**
 * Importa colecciones Postman v2.x conservando lo que antes se descartaba:
 * `events` (prerequest/test a nivel raíz, carpeta y petición), query params
 * con su flag `disabled`, auth heredada de raíz/carpeta y avisos por auth
 * no soportada. El export v2.1 re-emite events y query.
 */
export function importPostman(raw: unknown): ImportResult {
  const root = asRecord(raw, "La colección de Postman no se reconoce");
  const info = asRecord(root.info ?? {}, "info");
  const warnings: string[] = [];
  const requests: RequestModel[] = [];
  const rootEvents = readEvents(root.event);
  // La raíz va solo a la colección: el motor ya corre los hooks de colección
  // antes de cada petición (ambiente → colección → petición). Que bajarla por
  // el walk duplicaría la ejecución.
  walk(array(root.item), "", requests, { auth: root.auth }, warnings);
  if (requests.length === 0) throw new Error("La colección de Postman no tiene peticiones");
  const collection: Collection = {
    id: uid("col"),
    name: text(info.name, "Postman"),
    variables: array(root.variable).map(postmanPair),
    requests,
    ...(rootEvents.pre ? { preScript: rootEvents.pre } : {}),
    ...(rootEvents.post ? { postScript: rootEvents.post } : {}),
  };
  return { collection, warnings };
}

export function exportPostman(collection: Collection): unknown {
  const rootEvents = eventBlocks(collection.preScript, collection.postScript);
  return {
    info: {
      name: collection.name,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    ...(rootEvents.length ? { event: rootEvents } : {}),
    variable: collection.variables.filter((item) => item.key.trim()).map((item) => ({ key: item.key, value: item.value })),
    item: collection.requests.map((request) => {
      const events = eventBlocks(request.preScript, request.postScript);
      return {
        name: request.name,
        ...(events.length ? { event: events } : {}),
        request: {
          method: request.method,
          header: request.headers.filter((item) => item.key.trim()).map((item) => ({ key: item.key, value: item.value, disabled: !item.enabled })),
          url: exportUrl(request),
          description: request.description,
          auth: exportAuth(request.auth),
          body: exportBody(request),
        },
      };
    }),
  };
}

/** Url como objeto cuando hay params: conserva los flags `disabled` al exportar. */
function exportUrl(request: RequestModel): unknown {
  const query = request.params
    .filter((item) => item.key.trim())
    .map((item) => ({ key: item.key, value: item.value, disabled: !item.enabled }));
  if (query.length === 0) return request.url;
  const enabled = query
    .filter((item) => !item.disabled)
    .map((item) => `${encodeURIComponent(item.key)}=${encodeURIComponent(item.value)}`)
    .join("&");
  return {
    raw: `${request.url}${enabled ? `?${enabled}` : ""}`,
    query,
  };
}

function walk(items: unknown[], prefix: string, out: RequestModel[], ctx: Ctx, warnings: string[]): void {
  for (const item of items) {
    const record = asRecord(item, "ítem");
    const name = text(record.name, "Petición");
    if (Array.isArray(record.item)) {
      const events = readEvents(record.event);
      const folderCtx: Ctx = {
        auth: record.auth ?? ctx.auth,
        pre: joinScripts(ctx.pre, events.pre),
        post: joinScripts(ctx.post, events.post),
      };
      walk(record.item, `${prefix}${name} / `, out, folderCtx, warnings);
      continue;
    }
    if (record.request) {
      const own = readEvents(record.event);
      out.push(
        fromRequest(record.request, `${prefix}${name}`, {
          ...ctx,
          auth: record.auth ?? ctx.auth,
          pre: joinScripts(ctx.pre, own.pre),
          post: joinScripts(ctx.post, own.post),
        }, warnings),
      );
    }
  }
}

function fromRequest(raw: unknown, name: string, ctx: Ctx, warnings: string[]): RequestModel {
  const request = typeof raw === "string" ? { url: raw, method: "GET" } : asRecord(raw, "request");
  const method = text(request.method, "GET").toUpperCase();
  const { url, params } = readUrl(request.url);
  const headers = array(request.header).map((item) => {
    const header = asRecord(item, "header");
    return { ...pair(text(header.key, ""), text(header.value, "")), enabled: header.disabled !== true };
  });
  const body = readBody(request.body);
  return createRequest({
    name,
    description: text(request.description, ""),
    method: isMethod(method) ? method : "GET",
    url,
    params,
    headers,
    bodyMode: body.mode,
    bodyRaw: body.raw,
    form: body.form,
    auth: readAuth(effectiveAuth(request.auth, ctx), warnings, name),
    ...(ctx.pre ? { preScript: ctx.pre } : {}),
    ...(ctx.post ? { postScript: ctx.post } : {}),
  });
}

/** `auth: inherit` o ausente → lo heredado de la carpeta/raíz. */
function effectiveAuth(own: unknown, ctx: Ctx): unknown {
  const record = own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : undefined;
  if (record && record.type === "inherit") return ctx.auth;
  return own ?? ctx.auth;
}

function readUrl(value: unknown): { url: string; params: Pair[] } {
  if (typeof value === "string") return splitQuery(value);
  if (!value || typeof value !== "object") return { url: "", params: [] };
  const record = value as Record<string, unknown>;
  let raw = typeof record.raw === "string" ? record.raw : "";
  if (raw) {
    for (const item of array(record.variable)) {
      const row = asRecord(item, "variable");
      const key = text(row.key, "");
      if (!key || row.disabled === true) continue;
      raw = raw.replaceAll(`:${key}`, text(row.value, ""));
    }
    const split = splitQuery(raw);
    // El array `query` es la fuente de verdad de flags `disabled` (y de params
    // que ni siquiera aparecen en el raw renderizado).
    const rows = array(record.query).map((item) => asRecord(item, "query")).filter((row) => text(row.key, ""));
    if (rows.length > 0) {
      split.params = rows.map((row) => ({ ...pair(text(row.key, ""), text(row.value, "")), enabled: row.disabled !== true }));
    }
    return split;
  }
  const host = Array.isArray(record.host) ? record.host.join(".") : text(record.host, "");
  const path = array(record.path)
    .map((step) => text(step, ""))
    .filter(Boolean)
    .join("/");
  const protocol = text(record.protocol, "https");
  const port = record.port ? `:${text(record.port, "")}` : "";
  const params = array(record.query)
    .map((item) => asRecord(item, "query"))
    .filter((row) => text(row.key, ""))
    .map((row) => ({ ...pair(text(row.key, ""), text(row.value, "")), enabled: row.disabled !== true }));
  if (!host) return { url: "", params };
  return { url: `${protocol}://${host}${port}/${path}`, params };
}

/** Parte la query del `raw` hacia `params`: `prepare` la re-inserta al ejecutar.
 * Compartido con el importador de Insomnia (mismo contrato de URL+params). */
export function splitQuery(raw: string): { url: string; params: Pair[] } {
  const hash = raw.indexOf("#");
  const withoutHash = hash >= 0 ? raw.slice(0, hash) : raw;
  const fragment = hash >= 0 ? raw.slice(hash) : "";
  const at = withoutHash.indexOf("?");
  if (at < 0) return { url: withoutHash + fragment, params: [] };
  const params = withoutHash
    .slice(at + 1)
    .split("&")
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      return pair(eq < 0 ? decode(entry) : decode(entry.slice(0, eq)), eq < 0 ? "" : decode(entry.slice(eq + 1)));
    });
  return { url: withoutHash.slice(0, at) + fragment, params };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", "%20"));
  } catch {
    return value;
  }
}

function readEvents(value: unknown): { pre?: string; post?: string } {
  let pre = "";
  let post = "";
  for (const item of array(value)) {
    const record = asRecord(item, "event");
    const listen = text(record.listen, "");
    const code = scriptOf(record.script);
    if (!code) continue;
    if (listen === "prerequest") pre = joinScripts(pre, code) ?? "";
    if (listen === "test") post = joinScripts(post, code) ?? "";
  }
  return { ...(pre ? { pre } : {}), ...(post ? { post } : {}) };
}

function scriptOf(value: unknown): string {
  // El esquema v2.1 dice `script: { exec }`, pero colecciones viejas traen el
  // script como string plano: lo aceptamos.
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const exec = (value as Record<string, unknown>).exec;
  if (typeof exec === "string") return exec;
  if (Array.isArray(exec)) return exec.map((line) => text(line, "")).join("\n");
  return "";
}

/** Une scripts ancestro→descendiente (o `undefined` si no hay ninguno). */
export function joinScripts(head: string | undefined, tail: string | undefined): string | undefined {
  if (head && tail) return `${head}\n\n${tail}`;
  if (head) return head;
  if (tail) return tail;
  return undefined;
}

function eventBlocks(pre?: string, post?: string): unknown[] {
  const rows: unknown[] = [];
  if (pre?.trim()) rows.push({ listen: "prerequest", script: { type: "text/javascript", exec: pre.split("\n") } });
  if (post?.trim()) rows.push({ listen: "test", script: { type: "text/javascript", exec: post.split("\n") } });
  return rows;
}

function readAuth(value: unknown, warnings: string[], name: string): Auth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "none" };
  const auth = value as Record<string, unknown>;
  const bag = (key: string) => {
    const rows = array(auth[key]);
    const found = rows.map((item) => asRecord(item, key)).find((item) => item.key === "token" || item.key === "value" || item.key === "key");
    return found ? text(found.value, "") : text(rows[0] && asRecord(rows[0], key).value, "");
  };
  if (auth.type === "bearer") return { type: "bearer", token: bag("bearer") };
  if (auth.type === "basic") {
    const rows = array(auth.basic).map((item) => asRecord(item, "basic"));
    const username = rows.find((item) => item.key === "username");
    const password = rows.find((item) => item.key === "password");
    return { type: "basic", username: text(username?.value, ""), password: text(password?.value, "") };
  }
  if (auth.type === "apikey") {
    const rows = array(auth.apikey).map((item) => asRecord(item, "apikey"));
    const key = rows.find((item) => item.key === "key");
    const val = rows.find((item) => item.key === "value");
    const place = rows.find((item) => item.key === "in");
    return {
      type: "apikey",
      key: text(key?.value, ""),
      value: text(val?.value, ""),
      in: place?.value === "query" ? "query" : "header",
    };
  }
  const type = text(auth.type, "none");
  if (type && type !== "noauth" && type !== "none") {
    warnings.push(`Auth «${type}» de «${name}» no se importó (soportados: basic, bearer, apikey)`);
  }
  return { type: "none" };
}

function exportAuth(auth: Auth): unknown {
  if (auth.type === "bearer") return { type: "bearer", bearer: [{ key: "token", value: auth.token, type: "string" }] };
  if (auth.type === "basic") {
    return {
      type: "basic",
      basic: [
        { key: "username", value: auth.username, type: "string" },
        { key: "password", value: auth.password, type: "string" },
      ],
    };
  }
  if (auth.type === "apikey") {
    return {
      type: "apikey",
      apikey: [
        { key: "key", value: auth.key, type: "string" },
        { key: "value", value: auth.value, type: "string" },
        { key: "in", value: auth.in, type: "string" },
      ],
    };
  }
  return { type: "noauth" };
}

function exportBody(request: RequestModel): unknown {
  if (request.bodyMode === "json" || request.bodyMode === "text") {
    return { mode: "raw", raw: request.bodyRaw, options: request.bodyMode === "json" ? { raw: { language: "json" } } : undefined };
  }
  if (request.bodyMode === "form") {
    return { mode: "urlencoded", urlencoded: request.form.map((item) => ({ key: item.key, value: item.value, disabled: !item.enabled })) };
  }
  return undefined;
}

function postmanPair(value: unknown): Pair {
  const row = asRecord(value, "variable");
  return pair(text(row.key, ""), text(row.value, ""));
}

function readBody(value: unknown): { mode: RequestModel["bodyMode"]; raw: string; form: Pair[] } {
  if (!value || typeof value !== "object") return { mode: "none", raw: "", form: [] };
  const body = value as Record<string, unknown>;
  if (body.mode === "raw") {
    const raw = text(body.raw, "");
    const language = nestedLanguage(body.options);
    return { mode: language === "json" || looksJson(raw) ? "json" : "text", raw, form: [] };
  }
  if (body.mode === "urlencoded" || body.mode === "formdata") {
    const form = array(body.urlencoded ?? body.formdata).map((item) => {
      const row = asRecord(item, "campo");
      return { ...pair(text(row.key, ""), text(row.value, "")), enabled: row.disabled !== true };
    });
    return { mode: "form", raw: "", form };
  }
  return { mode: "none", raw: "", form: [] };
}

function nestedLanguage(options: unknown): string {
  if (!options || typeof options !== "object") return "";
  const raw = (options as { raw?: { language?: string } }).raw;
  return raw?.language ?? "";
}

function looksJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} no es válido`);
  return value as Record<string, unknown>;
}
