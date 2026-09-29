import type { Assertion, Auth, HttpMethod, Pair, RequestModel } from "./types.ts";

export function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function pair(key = "", value = "", id = uid("pair")): Pair {
  return { id, key, value, enabled: true };
}

export function assertion(
  source: Assertion["source"] = "status",
  op: Assertion["op"] = "eq",
  expected = "200",
  path = "",
  id = uid("assert"),
): Assertion {
  return { id, source, op, path, expected };
}

export function createRequest(partial: Partial<RequestModel> = {}): RequestModel {
  return {
    id: partial.id ?? uid("req"),
    name: partial.name ?? "Nueva petición",
    description: partial.description ?? "",
    method: partial.method ?? "GET",
    url: partial.url ?? "",
    params: partial.params ?? [],
    headers: partial.headers ?? [],
    bodyMode: partial.bodyMode ?? "none",
    bodyRaw: partial.bodyRaw ?? "",
    form: partial.form ?? [],
    auth: partial.auth ?? { type: "none" },
    assertions: partial.assertions ?? [],
    extractors: partial.extractors ?? [],
    timeoutMs: partial.timeoutMs ?? 30000,
    followRedirects: partial.followRedirects ?? true,
  };
}

export function blankAuth(type: Auth["type"]): Auth {
  if (type === "bearer") return { type, token: "" };
  if (type === "basic") return { type, username: "", password: "" };
  if (type === "apikey") return { type, key: "", value: "", in: "header" };
  return { type: "none" };
}

export function isMethod(value: string): value is HttpMethod {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(value);
}
