import { createRequest, isMethod, pair, uid } from "./factory.ts";
import type { Auth, Collection, Pair, RequestModel } from "./types.ts";

export function importPostman(raw: unknown): Collection {
  const root = asRecord(raw, "La colección de Postman no se reconoce");
  const info = asRecord(root.info ?? {}, "info");
  const requests: RequestModel[] = [];
  walk(array(root.item), "", requests);
  if (requests.length === 0) throw new Error("La colección de Postman no tiene peticiones");
  return {
    id: uid("col"),
    name: text(info.name, "Postman"),
    variables: array(root.variable).map(postmanPair),
    requests,
  };
}

export function exportPostman(collection: Collection): unknown {
  return {
    info: {
      name: collection.name,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    variable: collection.variables.filter((item) => item.key.trim()).map((item) => ({ key: item.key, value: item.value })),
    item: collection.requests.map((request) => ({
      name: request.name,
      request: {
        method: request.method,
        header: request.headers.filter((item) => item.key.trim()).map((item) => ({ key: item.key, value: item.value, disabled: !item.enabled })),
        url: request.url,
        description: request.description,
        auth: exportAuth(request.auth),
        body: exportBody(request),
      },
    })),
  };
}

function walk(items: unknown[], prefix: string, out: RequestModel[]) {
  for (const item of items) {
    const record = asRecord(item, "ítem");
    const name = text(record.name, "Petición");
    if (Array.isArray(record.item)) {
      walk(record.item, `${prefix}${name} / `, out);
      continue;
    }
    if (record.request) out.push(fromRequest(record.request, `${prefix}${name}`));
  }
}

function fromRequest(raw: unknown, name: string): RequestModel {
  const request = typeof raw === "string" ? { url: raw, method: "GET" } : asRecord(raw, "request");
  const method = text(request.method, "GET").toUpperCase();
  const url = readUrl(request.url);
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
    headers,
    bodyMode: body.mode,
    bodyRaw: body.raw,
    form: body.form,
    auth: readAuth(request.auth),
  });
}

function readUrl(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  let raw = typeof record.raw === "string" ? record.raw : "";
  for (const item of array(record.variable)) {
    const row = asRecord(item, "variable");
    const key = text(row.key, "");
    if (!key || row.disabled === true) continue;
    raw = raw.replaceAll(`:${key}`, text(row.value, ""));
  }
  if (raw) return raw;
  const host = Array.isArray(record.host) ? record.host.join(".") : text(record.host, "");
  const path = Array.isArray(record.path) ? record.path.join("/") : "";
  const protocol = text(record.protocol, "https");
  const port = record.port ? `:${record.port}` : "";
  const query = array(record.query)
    .map((item) => asRecord(item, "query"))
    .filter((item) => item.disabled !== true && text(item.key, ""))
    .map((item) => `${encodeURIComponent(text(item.key, ""))}=${encodeURIComponent(text(item.value, ""))}`)
    .join("&");
  if (!host) return "";
  return `${protocol}://${host}${port}/${path}${query ? `?${query}` : ""}`;
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

function readAuth(value: unknown): Auth {
  if (!value || typeof value !== "object") return { type: "none" };
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
