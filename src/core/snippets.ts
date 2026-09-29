import { prepareRequest } from "./execute.ts";
import type { RequestModel } from "./types.ts";

export type SnippetKind = "curl" | "fetch" | "python";

export function toFetch(request: RequestModel, variables: Record<string, string>): string {
  const prepared = prepareRequest(request, variables);
  const headers = Object.fromEntries(prepared.headers.filter(([key]) => !isDefault(key, prepared.headers)));
  const lines = [
    ...(prepared.error ? [`// ${prepared.error}`] : []),
    `const response = await fetch(${quote(prepared.url || request.url)}, {`,
    `  method: ${quote(prepared.method)},`,
  ];
  if (Object.keys(headers).length) lines.push(`  headers: ${JSON.stringify(headers, null, 2).replaceAll("\n", "\n  ")},`);
  if (prepared.body) lines.push(`  body: ${quote(prepared.body)},`);
  lines.push("});", "const body = await response.text();");
  return lines.join("\n");
}

export function toPython(request: RequestModel, variables: Record<string, string>): string {
  const prepared = prepareRequest(request, variables);
  const headers = Object.fromEntries(prepared.headers.filter(([key]) => !isDefault(key, prepared.headers)));
  const lines = [...(prepared.error ? [`# ${prepared.error}`] : []), "import requests", ""];
  lines.push(`response = requests.request(`);
  lines.push(`    ${quote(prepared.method)},`);
  lines.push(`    ${quote(prepared.url || request.url)},`);
  if (Object.keys(headers).length) lines.push(`    headers=${JSON.stringify(headers)},`);
  if (prepared.body && request.bodyMode === "json") lines.push(`    json=${prepared.body},`);
  else if (prepared.body) lines.push(`    data=${quote(prepared.body)},`);
  lines.push(")", "print(response.status_code)", "print(response.text)");
  return lines.join("\n");
}

function isDefault(key: string, headers: [string, string][]): boolean {
  const value = headers.find((item) => item[0] === key)?.[1] ?? "";
  if (key.toLowerCase() === "accept" && value === "*/*") return true;
  if (key.toLowerCase() === "user-agent" && value.startsWith("Omnium/")) return true;
  return false;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
