import { lookup } from "./jsonpath.ts";
import type { Assertion, AssertionResult, ExecutionResult } from "./types.ts";

export const OPS_FOR: Record<Assertion["source"], Assertion["op"][]> = {
  status: ["eq", "neq", "lt", "lte", "gt", "gte"],
  time: ["lt", "lte", "gt", "gte"],
  header: ["eq", "contains", "exists"],
  json: ["eq", "neq", "contains", "exists", "lt", "gt"],
  body: ["contains"],
};

export const OP_LABEL: Record<Assertion["op"], string> = {
  eq: "es",
  neq: "no es",
  lt: "menor que",
  lte: "menor o igual que",
  gt: "mayor que",
  gte: "mayor o igual que",
  contains: "contiene",
  exists: "existe",
};

const OP_TEXT: Record<Assertion["op"], string> = {
  eq: "igual a",
  neq: "distinto de",
  lt: "menor que",
  lte: "menor o igual que",
  gt: "mayor que",
  gte: "mayor o igual que",
  contains: "que contenga",
  exists: "existir",
};

export function evaluateAssertions(
  result: Pick<ExecutionResult, "status" | "timeMs" | "headers" | "bodyText" | "bodyJson">,
  assertions: Assertion[],
): AssertionResult[] {
  return assertions.map((assertion) => {
    const actual = readActual(result, assertion);
    const passed = compare(assertion.op, actual, assertion.expected);
    return { id: assertion.id, passed, message: describe(assertion, actual, passed) };
  });
}

export function stepPassed(result: ExecutionResult): boolean {
  if (result.error || result.status === null) return false;
  if (result.assertions.length === 0) return result.status < 400;
  return result.assertions.every((item) => item.passed);
}

function readActual(
  result: Pick<ExecutionResult, "status" | "timeMs" | "headers" | "bodyText" | "bodyJson">,
  assertion: Assertion,
): unknown {
  if (assertion.source === "status") return result.status;
  if (assertion.source === "time") return result.timeMs;
  if (assertion.source === "body") return result.bodyText;
  if (assertion.source === "header") {
    const found = result.headers.find((header) => header.name.toLowerCase() === assertion.path.trim().toLowerCase());
    return found?.value;
  }
  if (result.bodyJson === null || result.bodyJson === undefined) return undefined;
  const got = lookup(result.bodyJson, assertion.path);
  return got.found ? got.value : undefined;
}

function compare(op: Assertion["op"], actual: unknown, expectedRaw: string): boolean {
  if (op === "exists") return actual !== undefined && actual !== null;
  if (op === "contains") return contains(actual, expectedRaw);
  if (op === "eq") return same(actual, expectedRaw);
  if (op === "neq") return !same(actual, expectedRaw);
  const numbers = asNumbers(actual, expectedRaw);
  if (!numbers) return false;
  if (op === "lt") return numbers.left < numbers.right;
  if (op === "lte") return numbers.left <= numbers.right;
  if (op === "gt") return numbers.left > numbers.right;
  return numbers.left >= numbers.right;
}

function same(actual: unknown, expectedRaw: string): boolean {
  const expected = coerce(expectedRaw, actual);
  if (Object.is(actual, expected)) return true;
  if (typeof actual === "object" && actual !== null && typeof expected === "string") {
    return JSON.stringify(actual) === expected;
  }
  return false;
}

function contains(actual: unknown, expectedRaw: string): boolean {
  if (typeof actual === "string") return actual.includes(expectedRaw);
  if (Array.isArray(actual)) {
    return actual.some((item) => item === expectedRaw || String(item) === expectedRaw);
  }
  if (actual === undefined || actual === null) return false;
  return JSON.stringify(actual).includes(expectedRaw);
}

function coerce(expectedRaw: string, actual: unknown): unknown {
  if (typeof actual === "number" && expectedRaw.trim() !== "" && Number.isFinite(Number(expectedRaw))) {
    return Number(expectedRaw);
  }
  if (typeof actual === "boolean") {
    if (expectedRaw === "true") return true;
    if (expectedRaw === "false") return false;
  }
  if (actual === null && expectedRaw === "null") return null;
  return expectedRaw;
}

function asNumbers(actual: unknown, expectedRaw: string): { left: number; right: number } | null {
  const left = typeof actual === "number" ? actual : Number(actual);
  const right = Number(expectedRaw);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return { left, right };
}

function describe(assertion: Assertion, actual: unknown, passed: boolean): string {
  const label = sourceLabel(assertion);
  const seen = show(actual);
  if (assertion.op === "exists") return passed ? `${label} existe` : `${label} no existe`;
  if (passed) return `${label} (${seen}) es ${OP_TEXT[assertion.op]} ${assertion.expected || "vacío"}`;
  return `${label}: se esperaba ${OP_TEXT[assertion.op]} ${assertion.expected || "vacío"} y llegó ${seen}`;
}

function sourceLabel(assertion: Assertion): string {
  if (assertion.source === "status") return "Estado";
  if (assertion.source === "time") return "Tiempo";
  if (assertion.source === "body") return "Cuerpo";
  if (assertion.source === "header") return `Cabecera ${assertion.path || "(sin nombre)"}`;
  return `JSON ${assertion.path || "$"}`;
}

function show(value: unknown): string {
  if (value === undefined) return "vacío";
  if (typeof value === "string") return clip(value || "vacío");
  const text = JSON.stringify(value);
  return clip(text ?? "vacío");
}

function clip(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}…` : value;
}
