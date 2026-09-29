export type Lookup = { found: boolean; value: unknown };

export function lookup(root: unknown, path: string): Lookup {
  const expr = path.trim();
  if (!expr || expr === "$") return { found: true, value: root };

  let index = 0;
  if (expr.startsWith("$")) index = 1;
  let current: unknown = root;

  while (index < expr.length) {
    const mark = expr[index];
    if (mark === ".") {
      index += 1;
      const start = index;
      while (index < expr.length && expr[index] !== "." && expr[index] !== "[") index += 1;
      const key = expr.slice(start, index);
      if (!key) return { found: false, value: undefined };
      if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
        return { found: false, value: undefined };
      }
      current = current[key];
      continue;
    }

    if (mark === "[") {
      const end = expr.indexOf("]", index);
      if (end < 0) return { found: false, value: undefined };
      const inside = expr.slice(index + 1, end).trim();
      if (/^\d+$/.test(inside)) {
        const at = Number(inside);
        if (!Array.isArray(current) || at >= current.length) return { found: false, value: undefined };
        current = current[at];
      } else {
        const key = inside.replace(/^['"]|['"]$/g, "");
        if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
          return { found: false, value: undefined };
        }
        current = current[key];
      }
      index = end + 1;
      continue;
    }

    const start = index;
    while (index < expr.length && expr[index] !== "." && expr[index] !== "[") index += 1;
    const key = expr.slice(start, index);
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
      return { found: false, value: undefined };
    }
    current = current[key];
  }

  return { found: true, value: current };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
