import { createRequest, isMethod, pair, uid } from "./factory.ts";
import type { ImportResult } from "./interchange.ts";
import { splitQuery } from "./postman.ts";
import type { Assertion, Extractor, Pair, RequestModel } from "./types.ts";
import { parseXml, type XmlNode } from "./xmlMini.ts";

type Scope = { headers: Pair[]; assertions: Assertion[]; extractors: Extractor[] };
type Sink = { name: string; variables: Pair[]; warnings: string[]; planVars: Pair[]; maxThreads: number };

/**
 * Importa planes JMeter (`.jmx`) con parser XML dirigido: TestPlan → nombre y
 * variables, ThreadGroup → peticiones (con headers/asserts por scope),
 * HTTPSamplerProxy → petición (URL compuesta de dominio/puerto/protocolo/ruta,
 * query y `postBodyRaw`), ResponseAssertion → aserciones, CSVDataSet →
 * variables. El plan de carga (hilos/vueltas) NO se mapea: se avisa.
 */
export function importJmeter(text: string): ImportResult {
  const root = parseXml(text);
  if (root.tag !== "jmeterTestPlan") throw new Error("El archivo no es un plan JMeter (falta jmeterTestPlan)");
  const sink: Sink = { name: "", variables: [], warnings: [], planVars: [], maxThreads: 1 };
  const requests: RequestModel[] = [];
  const tree = root.children.find((child) => child.tag === "hashTree");
  walk(tree?.children ?? [], { headers: [], assertions: [], extractors: [] }, requests, sink);
  if (requests.length === 0) throw new Error("El plan JMeter no tiene peticiones HTTP");
  const collection = {
    id: uid("col"),
    name: sink.name || "JMeter",
    variables: [...sink.planVars, ...sink.variables],
    requests,
  };
  return { collection, warnings: sink.warnings };
}

/** Recorre una lista de nodos emparejando cada elemento con su `hashTree` hijo. */
function walk(nodes: XmlNode[], scope: Scope, out: RequestModel[], sink: Sink): void {
  const local: Scope = { headers: [...scope.headers], assertions: [...scope.assertions], extractors: [...scope.extractors] };
  // 1ª pasada: config elements del nivel (aplican a todo el scope).
  forEachPair(nodes, (element) => {
    if (element.tag === "HeaderManager") local.headers.push(...readHeaders(element));
    else if (element.tag === "ResponseAssertion") local.assertions.push(...readAssertions(element, sink.warnings));
    else if (element.tag === "CSVDataSet") readCsv(element, sink);
    else if (element.tag === "JSONPostProcessor" || element.tag === "RegexExtractor") local.extractors.push(...readExtractors(element, sink.warnings));
    else if (element.tag === "ThreadGroup") readThreadGroup(element, sink);
  });
  // 2ª pasada: samplers y anidamiento.
  forEachPair(nodes, (element, tree) => {
    if (element.tag === "HTTPSamplerProxy") {
      out.push(readSampler(element, tree, local, sink.warnings));
      return;
    }
    if (element.tag === "TestPlan") {
      if (!sink.name) sink.name = element.attrs.testname ?? "";
      sink.planVars.push(...readArguments(findElement(element, "TestPlan.user_defined_variables")));
      walk(tree, local, out, sink);
      return;
    }
    if (
      element.tag === "hashTree" ||
      element.tag === "HeaderManager" ||
      element.tag === "ResponseAssertion" ||
      element.tag === "CSVDataSet" ||
      element.tag === "JSONPostProcessor" ||
      element.tag === "RegexExtractor"
    ) return;
    walk(tree, local, out, sink);
  });
}

function readSampler(element: XmlNode, tree: XmlNode[], scope: Scope, warnings: string[]): RequestModel {
  const name = element.attrs.testname ?? "Petición JMeter";
  const rawMethod = (prop(element, "HTTPSampler.method") ?? "GET").toUpperCase();
  let method: RequestModel["method"] = "GET";
  if (isMethod(rawMethod)) method = rawMethod;
  else warnings.push(`Método "${rawMethod}" de "${name}" no soportado; se importó como GET`);

  const path = prop(element, "HTTPSampler.path") ?? "";
  const split = splitQuery(path);
  const postBodyRaw = prop(element, "HTTPSampler.postBodyRaw") === "true";
  const args = readSamplerArgs(element);
  const bodyMethods = ["POST", "PUT", "PATCH"];
  const usesBody = args.length > 0 && bodyMethods.includes(method) && !path.includes("?");

  let bodyMode: RequestModel["bodyMode"] = "none";
  let bodyRaw = "";
  let form: Pair[] = [];
  let params = split.params;
  if (postBodyRaw) {
    bodyRaw = args[0]?.value ?? "";
    bodyMode = bodyRaw.trim() ? (bodyRaw.trim().startsWith("{") || bodyRaw.trim().startsWith("[") ? "json" : "text") : "none";
  } else if (usesBody) {
    bodyMode = "form";
    form = args;
  } else if (args.length > 0) {
    params = args;
  }

  // Config elements dentro del sampler (scope propio) + scope heredado.
  const own: Scope = { headers: [], assertions: [], extractors: [] };
  forEachPair(tree, (child) => {
    if (child.tag === "HeaderManager") own.headers.push(...readHeaders(child));
    else if (child.tag === "ResponseAssertion") own.assertions.push(...readAssertions(child, warnings));
    else if (child.tag === "JSONPostProcessor" || child.tag === "RegexExtractor") own.extractors.push(...readExtractors(child, warnings));
  });

  const redirect = prop(element, "HTTPSampler.follow_redirects");
  return createRequest({
    name,
    method,
    url: buildUrl(element, split.url),
    params,
    headers: [...scope.headers, ...own.headers],
    bodyMode,
    bodyRaw,
    form,
    assertions: [...scope.assertions, ...own.assertions],
    extractors: [...scope.extractors, ...own.extractors],
    ...(redirect !== undefined ? { followRedirects: redirect === "true" } : {}),
  });
}

/** `protocol://dominio[:puerto]/ruta`; una ruta absoluta ya trae su URL. */
function buildUrl(element: XmlNode, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const domain = prop(element, "HTTPSampler.domain") ?? "";
  if (!domain) return path;
  const port = prop(element, "HTTPSampler.port") ?? "";
  const given = prop(element, "HTTPSampler.protocol") ?? "";
  const protocol = given || (port === "443" ? "https" : "http");
  const isDefaultPort = (protocol === "http" && port === "80") || (protocol === "https" && port === "443");
  const suffix = port && !isDefaultPort ? `:${port}` : "";
  const cleanPath = path.startsWith("/") || path === "" ? path : `/${path}`;
  return `${protocol}://${domain}${suffix}${cleanPath}`;
}

function readHeaders(element: XmlNode): Pair[] {
  const out: Pair[] = [];
  for (const header of childrenOf(element, "HeaderManager.headers")) {
    const name = prop(header, "Header.name") ?? "";
    if (!name) continue;
    out.push(pair(name, prop(header, "Header.value") ?? ""));
  }
  return out;
}

/** ResponseAssertion dirigido: código/status, body, headers con nombre y JSON cuando el destino lo permite. */
function readAssertions(element: XmlNode, warnings: string[]): Assertion[] {
  const field = prop(element, "Assertion.test_field") ?? "";
  const type = Number(prop(element, "Assertion.test_type") ?? "0");
  const texts = childrenOf(element, "Assertion.test_strings")
    .map((node) => node.text)
    .filter((value) => value !== "");
  const negated = (type & 1) !== 0;
  const equalsLike = (type & 8) !== 0 || (type & 16) !== 0;
  const containsLike = (type & 2) !== 0;
  const testname = element.attrs.testname ?? "assertion";
  const out: Assertion[] = [];
  for (const expected of texts) {
    if (field === "Assertion.response_code" && equalsLike) {
      out.push({ id: uid("assert"), source: "status", op: negated ? "neq" : "eq", path: "", expected });
      continue;
    }
    if ((field === "Assertion.response_data" || field === "Assertion.response_data_as_document") && containsLike && !negated) {
      out.push({ id: uid("assert"), source: "body", op: "contains", path: "", expected });
      continue;
    }
    if (field === "Assertion.response_headers" && containsLike && !negated) {
      const split = /^([^:]+):\s*(.+)$/.exec(expected);
      if (split) {
        out.push({ id: uid("assert"), source: "header", op: "contains", path: split[1].trim(), expected: split[2].trim() });
        continue;
      }
    }
    warnings.push(`Aserción JMeter "${testname}" (${field}, tipo ${type}) no soportada; se omitió`);
  }
  return out;
}

function readExtractors(element: XmlNode, warnings: string[]): Extractor[] {
  const testname = element.attrs.testname ?? element.tag;
  if (element.tag === "JSONPostProcessor") {
    const names = splitList(prop(element, "JSONPostProcessor.referenceNames") ?? "");
    const paths = splitList(prop(element, "JSONPostProcessor.jsonPathExprs") ?? "");
    const out: Extractor[] = [];
    names.forEach((name, index) => {
      const path = paths[index] ?? paths[0] ?? "";
      if (!name || !path) return;
      out.push({ id: uid("ext"), name, source: "json", path });
    });
    if (out.length === 0) warnings.push(`Extractor JSON JMeter "${testname}" sin variable o JSONPath; se omitió`);
    return out;
  }
  const variable = prop(element, "RegexExtractor.refname") ?? "";
  const regex = prop(element, "RegexExtractor.regex") ?? "";
  warnings.push(`RegexExtractor JMeter "${testname}"${variable ? ` → ${variable}` : ""} no se puede mapear a extractores nativos JSON/header; regex: ${regex || "(vacía)"}`);
  return [];
}

function readThreadGroup(element: XmlNode, sink: Sink): void {
  const name = element.attrs.testname ?? "ThreadGroup";
  const threads = Number(prop(element, "ThreadGroup.num_threads") ?? "1");
  if (Number.isFinite(threads)) sink.maxThreads = Math.max(sink.maxThreads, threads);
  const ramp = prop(element, "ThreadGroup.ramp_time") ?? "0";
  const duration = prop(element, "ThreadGroup.duration") ?? prop(element, "duration") ?? "";
  const loops = prop(findElement(element, "ThreadGroup.main_controller") ?? element, "LoopController.loops") ?? "";
  const scheduler = prop(element, "ThreadGroup.scheduler") === "true";
  const parts = [`${Number.isFinite(threads) ? threads : 1} hilos`, `ramp-up ${ramp || "0"}s`];
  if (loops) parts.push(`loops ${loops}`);
  if (scheduler && duration) parts.push(`duración ${duration}s`);
  sink.warnings.push(`ThreadGroup "${name}" preservado como metadata de importación (${parts.join(", ")}); Omnium no ejecuta el plan JMeter completo`);
}

function readCsv(element: XmlNode, sink: Sink): void {
  const filename = prop(element, "CSVDataSet.filename") ?? "";
  const names = (prop(element, "CSVDataSet.variableNames") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (names.length === 0) {
    sink.warnings.push(`CSV "${filename || "(sin nombre)"}": nombres de variables no disponibles; se omitió`);
    return;
  }
  for (const name of names) sink.variables.push(pair(name, ""));
  sink.warnings.push(`CSVDataSet "${filename || "(sin nombre)"}": columnas ${names.join(", ")} importadas como variables vacías; Omnium no lee el CSV en runtime`);
}

function splitList(value: string): string[] {
  return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function readSamplerArgs(element: XmlNode): Pair[] {
  const holder = findElement(element, "HTTPsampler.Arguments") ?? findElement(element, "HTTPSampler.Arguments");
  if (!holder) return [];
  const out: Pair[] = [];
  for (const argument of childrenOf(holder, "Arguments.arguments")) {
    const name = prop(argument, "Argument.name") ?? "";
    const value = prop(argument, "Argument.value") ?? "";
    if (!name && !value) continue;
    out.push(pair(name, value));
  }
  return out;
}

function readArguments(holder: XmlNode | undefined): Pair[] {
  if (!holder) return [];
  const out: Pair[] = [];
  for (const argument of childrenOf(holder, "Arguments.arguments")) {
    const name = prop(argument, "Argument.name") ?? "";
    if (!name) continue;
    out.push(pair(name, prop(argument, "Argument.value") ?? ""));
  }
  return out;
}

function forEachPair(nodes: XmlNode[], fn: (element: XmlNode, tree: XmlNode[]) => void): void {
  for (let i = 0; i < nodes.length; i += 1) {
    const element = nodes[i];
    if (!element || element.tag === "hashTree") continue;
    const next = nodes[i + 1];
    fn(element, next?.tag === "hashTree" ? next.children : []);
  }
}

/** Propiedad directa `stringProp`/`boolProp`/`intProp`/`longProp` por nombre. */
function prop(element: XmlNode, name: string): string | undefined {
  for (const child of element.children) {
    if (child.attrs.name === name && (child.tag === "stringProp" || child.tag === "boolProp" || child.tag === "intProp" || child.tag === "longProp")) {
      return child.text;
    }
  }
  return undefined;
}

function findElement(element: XmlNode, name: string): XmlNode | undefined {
  for (const child of element.children) {
    if (child.attrs.name === name) return child;
    const nested = findElement(child, name);
    if (nested) return nested;
  }
  return undefined;
}

/** Hijos de la `collectionProp` con ese nombre (elementProp o stringProp). */
function childrenOf(element: XmlNode, collectionName: string): XmlNode[] {
  const collection = findElement(element, collectionName);
  if (!collection) return [];
  return collection.children;
}
