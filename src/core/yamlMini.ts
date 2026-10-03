/**
 * Parser YAML mínimo, sin dependencias, para el subconjunto que Insomnia v5
 * genera en sus exports (`collection.insomnia.rest/5.0`): mapas y secuencias
 * por sangría, escalares planos/citados, flow `[..]`/`{..}` y bloques `|`/`>`.
 * Lo que queda fuera del subconjunto lanza error con número de línea; nunca
 * adivina ni degrada en silencio.
 */

type State = { lines: string[]; i: number };

const BLOCK_HEADER = /^[|>][+-]?\d*$/;

export function parseYaml(source: string): unknown {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const s: State = { lines, i: 0 };
  skipBlank(s);
  if (s.i < lines.length && lines[s.i].trim() === "---") s.i += 1;
  skipBlank(s);
  if (s.i >= lines.length) return null;
  const value = parseNode(s, indentOf(s.lines[s.i]));
  skipBlank(s);
  if (s.i < s.lines.length) throw fail(s, "contenido inesperado después del documento");
  return value;
}

/** Nodo completo en la sangría indicada: secuencia, mapa o escalar suelto. */
function parseNode(s: State, indent: number): unknown {
  const line = s.lines[s.i];
  const ind = indentOf(line);
  if (ind < indent) return null;
  const content = line.slice(ind);
  if (content === "-" || content.startsWith("- ")) return parseSeq(s, ind);
  if (splitKey(content)) return parseMap(s, ind);
  s.i += 1;
  return parseScalar(content, s.i);
}

function parseMap(s: State, indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (;;) {
    skipBlank(s);
    if (s.i >= s.lines.length) break;
    const line = s.lines[s.i];
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) throw fail(s, "sangría inesperada dentro del mapa");
    const content = line.slice(ind);
    if (content === "-" || content.startsWith("- ")) break;
    const split = splitKey(content);
    if (!split) throw fail(s, `se esperaba "clave: valor" y vino "${content.trim()}"`);
    s.i += 1;
    if (BLOCK_HEADER.test(split.rest)) out[split.key] = parseBlockScalar(s, indent, split.rest);
    else if (split.rest === "") out[split.key] = parseNested(s, indent);
    else out[split.key] = parseScalar(split.rest, s.i);
  }
  return out;
}

/** Valor anidado bajo una clave sin contenido en la misma línea. */
function parseNested(s: State, parentIndent: number): unknown {
  skipBlank(s);
  if (s.i >= s.lines.length) return null;
  const line = s.lines[s.i];
  const ind = indentOf(line);
  const content = line.slice(ind);
  if (ind > parentIndent) return parseNode(s, ind);
  // YAML permite la secuencia a la misma sangría que su clave.
  if (ind === parentIndent && (content === "-" || content.startsWith("- "))) return parseSeq(s, ind);
  return null;
}

function parseSeq(s: State, indent: number): unknown[] {
  const out: unknown[] = [];
  for (;;) {
    skipBlank(s);
    if (s.i >= s.lines.length) break;
    const line = s.lines[s.i];
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) throw fail(s, "sangría inesperada dentro de la secuencia");
    const content = line.slice(ind);
    if (content !== "-" && !content.startsWith("- ")) break;
    if (content === "-") {
      s.i += 1;
      out.push(parseNested(s, indent));
      continue;
    }
    // `- clave: valor` reescribe la línea para que el ítem se lea como un nodo
    // con sangría local; las siguientes claves del ítem se alinean con esa columna.
    const stripped = content.replace(/^- +/, "");
    const col = ind + (content.length - stripped.length);
    s.lines[s.i] = " ".repeat(col) + stripped;
    out.push(parseNode(s, col));
  }
  return out;
}

/** Bloque literal `|`/`| -`/`|+` o plegado `>`; conserva el texto crudo. */
function parseBlockScalar(s: State, parentIndent: number, header: string): string {
  const folded = header.startsWith(">");
  const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
  let end = s.i;
  while (end < s.lines.length) {
    const line = s.lines[end];
    if (line.trim() === "") {
      end += 1;
      continue;
    }
    if (indentOf(line) > parentIndent) {
      end += 1;
      continue;
    }
    break;
  }
  const body = s.lines.slice(s.i, end);
  s.i = end;
  const first = body.find((line) => line.trim() !== "");
  if (first === undefined) return "";
  const blockIndent = indentOf(first);
  const dedented = body.map((line) => (line.trim() === "" ? "" : line.slice(blockIndent)));
  let text = folded ? foldLines(dedented) : dedented.join("\n");
  if (chomp === "strip") text = text.replace(/\n+$/, "");
  else if (chomp === "clip") text = text.replace(/\n*$/, "\n");
  else text = text.replace(/\n*$/, "\n");
  return text;
}

function foldLines(lines: string[]): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      out.push(paragraph.join(" "));
      paragraph = [];
    }
  };
  for (const line of lines) {
    if (line === "") {
      flush();
      out.push("");
    } else paragraph.push(line);
  }
  flush();
  return out.join("\n");
}

/** Divide `clave: resto` en la primera `:` de nivel superior seguida de espacio. */
function splitKey(content: string): { key: string; rest: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ":" && (i + 1 >= content.length || content[i + 1] === " ")) {
      const rawKey = content.slice(0, i).trim();
      if (!rawKey) return null;
      const key = unquote(rawKey);
      return { key, rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return readDouble(value);
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return readSingle(value);
  return value;
}

function parseScalar(raw: string, line: number): unknown {
  const value = stripComment(raw).trim();
  if (value === "" || value === "null" || value === "~") return null;
  if (value.startsWith('"')) return readDouble(value);
  if (value.startsWith("'")) return readSingle(value);
  if (value.startsWith("[") || value.startsWith("{")) {
    const pos = { i: 0 };
    const parsed = flowValue(value, pos, line);
    return parsed;
  }
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Quita comentario en línea (` # …`) respetando comillas. */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

function readDouble(value: string): string {
  let out = "";
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '"') return out;
    if (ch === "\\") {
      const next = value[i + 1];
      i += 1;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === "0") out += "\0";
      else if (next === "u") {
        const hex = value.slice(i + 1, i + 5);
        const code = Number.parseInt(hex, 16);
        out += Number.isNaN(code) ? `\\u${hex}` : String.fromCharCode(code);
        i += 4;
      } else out += next ?? "";
      continue;
    }
    out += ch;
  }
  return out;
}

function readSingle(value: string): string {
  let out = "";
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'") {
      if (value[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      return out;
    }
    out += ch;
  }
  return out;
}

function flowValue(input: string, pos: { i: number }, line: number): unknown {
  skipFlowWs(input, pos);
  const ch = input[pos.i];
  if (ch === "[") {
    pos.i += 1;
    const out: unknown[] = [];
    skipFlowWs(input, pos);
    if (input[pos.i] === "]") {
      pos.i += 1;
      return out;
    }
    for (;;) {
      out.push(flowValue(input, pos, line));
      skipFlowWs(input, pos);
      if (input[pos.i] === ",") {
        pos.i += 1;
        continue;
      }
      if (input[pos.i] === "]") {
        pos.i += 1;
        break;
      }
      throw fail({ lines: [input], i: 0 }, `secuencia flow sin cerrar (cerca de "${input.slice(pos.i, pos.i + 12)}")`, line);
    }
    return out;
  }
  if (ch === "{") {
    pos.i += 1;
    const out: Record<string, unknown> = {};
    skipFlowWs(input, pos);
    if (input[pos.i] === "}") {
      pos.i += 1;
      return out;
    }
    for (;;) {
      skipFlowWs(input, pos);
      const keyEnd = flowUntil(input, pos, ":");
      const key = unquote(keyEnd.trim());
      skipFlowWs(input, pos);
      if (input[pos.i] !== ":") throw fail({ lines: [input], i: 0 }, "mapa flow sin \":\"", line);
      pos.i += 1;
      out[key] = flowValue(input, pos, line);
      skipFlowWs(input, pos);
      if (input[pos.i] === ",") {
        pos.i += 1;
        continue;
      }
      if (input[pos.i] === "}") {
        pos.i += 1;
        break;
      }
      throw fail({ lines: [input], i: 0 }, "mapa flow sin cerrar", line);
    }
    return out;
  }
  if (ch === '"' || ch === "'") {
    const quote = ch;
    let end = pos.i + 1;
    while (end < input.length) {
      if (input[end] === "\\" && quote === '"') end += 2;
      else if (input[end] === quote) {
        end += 1;
        break;
      } else end += 1;
    }
    const raw = input.slice(pos.i, end);
    pos.i = end;
    return quote === '"' ? readDouble(raw) : readSingle(raw);
  }
  const plain = flowUntil(input, pos, ",]}").trim();
  if (plain === "" ) return null;
  if (/^(true|false)$/i.test(plain)) return plain.toLowerCase() === "true";
  if (/^-?\d+$/.test(plain)) return Number(plain);
  if (/^-?(\d+\.\d*|\.\d+)$/.test(plain)) return Number(plain);
  return plain;
}

/** Lee hasta uno de los delimitadores dados respetando comillas. */
function flowUntil(input: string, pos: { i: number }, delimiters: string): string {
  const start = pos.i;
  let quote: string | null = null;
  while (pos.i < input.length) {
    const ch = input[pos.i];
    if (quote) {
      if (quote === '"' && ch === "\\") pos.i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (delimiters.includes(ch)) break;
    pos.i += 1;
  }
  return input.slice(start, pos.i);
}

function skipFlowWs(input: string, pos: { i: number }): void {
  while (pos.i < input.length && /\s/.test(input[pos.i])) pos.i += 1;
}

function skipBlank(s: State): void {
  while (s.i < s.lines.length) {
    const line = s.lines[s.i];
    if (line.trim() === "" || /^\s*#/.test(line)) s.i += 1;
    else break;
  }
}

function indentOf(line: string): number {
  if (/^\s*\t/.test(line)) throw new Error(`YAML inválido en la línea: las sangrías deben ser espacios, no tabuladores`);
  let n = 0;
  while (n < line.length && line[n] === " ") n += 1;
  return n;
}

function fail(s: State, detail: string, line?: number): Error {
  return new Error(`YAML inválido en la línea ${line ?? s.i + 1}: ${detail}`);
}
