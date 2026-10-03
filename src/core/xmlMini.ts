/**
 * Parser XML mínimo, sin dependencias, para el subconjunto que JMeter
 * genera en `.jmx`: elementos con atributos, texto, comentarios, CDATA y
 * entidades básicas. Sin namespace ni DTD: lo que no encaja lanza error
 * con la posición; nunca adivina.
 */

export type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Texto directo del elemento (valor de `stringProp`, etc.). */
  text: string;
};

export function parseXml(source: string): XmlNode {
  const text = source.replace(/^\uFEFF/, "");
  const state = { text, i: 0 };
  skipMisc(state);
  if (state.i >= text.length || text[state.i] !== "<") throw fail(state, "se esperaba un elemento raíz");
  const root = readElement(state);
  skipMisc(state);
  return root;
}

type State = { text: string; i: number };

function readElement(s: State): XmlNode {
  if (s.text[s.i] !== "<") throw fail(s, "se esperaba `<`");
  s.i += 1;
  const tag = readName(s);
  const attrs: Record<string, string> = {};
  for (;;) {
    skipWs(s);
    if (s.i >= s.text.length) throw fail(s, `el elemento <${tag}> no está cerrado`);
    if (s.text[s.i] === "/" && s.text[s.i + 1] === ">") {
      s.i += 2;
      return { tag, attrs, children: [], text: "" };
    }
    if (s.text[s.i] === ">") {
      s.i += 1;
      break;
    }
    const name = readName(s);
    skipWs(s);
    if (s.text[s.i] !== "=") throw fail(s, `falta "=" en el atributo ${name} de <${tag}>`);
    s.i += 1;
    skipWs(s);
    attrs[name] = readAttrValue(s);
  }
  const children: XmlNode[] = [];
  let text = "";
  for (;;) {
    if (s.i >= s.text.length) throw fail(s, `el elemento <${tag}> no está cerrado`);
    const ch = s.text[s.i];
    if (ch === "<") {
      if (s.text.startsWith("</", s.i)) {
        s.i += 2;
        const close = readName(s);
        skipWs(s);
        if (s.text[s.i] !== ">") throw fail(s, `cierre de </${close}> inválido`);
        s.i += 1;
        if (close !== tag) throw fail(s, `se esperaba </${tag}> y vino </${close}>`);
        return { tag, attrs, children, text };
      }
      if (s.text.startsWith("<!--", s.i)) {
        const end = s.text.indexOf("-->", s.i + 4);
        if (end < 0) throw fail(s, "comentario sin cerrar");
        s.i = end + 3;
        continue;
      }
      if (s.text.startsWith("<![CDATA[", s.i)) {
        const end = s.text.indexOf("]]>", s.i + 9);
        if (end < 0) throw fail(s, "CDATA sin cerrar");
        text += s.text.slice(s.i + 9, end);
        s.i = end + 3;
        continue;
      }
      children.push(readElement(s));
      continue;
    }
    const next = s.text.indexOf("<", s.i);
    const chunk = s.text.slice(s.i, next < 0 ? s.text.length : next);
    text += decodeEntities(chunk);
    s.i = next < 0 ? s.text.length : next;
  }
}

function skipMisc(s: State): void {
  for (;;) {
    skipWs(s);
    if (s.text.startsWith("<?", s.i)) {
      const end = s.text.indexOf("?>", s.i);
      if (end < 0) throw fail(s, "declaración `<?` sin cerrar");
      s.i = end + 2;
      continue;
    }
    if (s.text.startsWith("<!--", s.i)) {
      const end = s.text.indexOf("-->", s.i + 4);
      if (end < 0) throw fail(s, "comentario sin cerrar");
      s.i = end + 3;
      continue;
    }
    if (s.text.startsWith("<!DOCTYPE", s.i) || s.text.startsWith("<!doctype", s.i)) {
      const end = s.text.indexOf(">", s.i);
      if (end < 0) throw fail(s, "DOCTYPE sin cerrar");
      s.i = end + 1;
      continue;
    }
    return;
  }
}

function readName(s: State): string {
  const start = s.i;
  while (s.i < s.text.length && /[A-Za-z0-9_.:-]/.test(s.text[s.i])) s.i += 1;
  if (s.i === start) throw fail(s, "nombre de elemento o atributo vacío");
  return s.text.slice(start, s.i);
}

function readAttrValue(s: State): string {
  const quote = s.text[s.i];
  if (quote !== '"' && quote !== "'") throw fail(s, "el valor del atributo debe ir entre comillas");
  s.i += 1;
  const start = s.i;
  while (s.i < s.text.length && s.text[s.i] !== quote) s.i += 1;
  if (s.i >= s.text.length) throw fail(s, "atributo sin cerrar");
  const value = s.text.slice(start, s.i);
  s.i += 1;
  return decodeEntities(value);
}

function skipWs(s: State): void {
  while (s.i < s.text.length && /\s/.test(s.text[s.i])) s.i += 1;
}

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, code: string) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
  });
}

function fail(s: State, detail: string): Error {
  const line = s.text.slice(0, s.i).split("\n").length;
  return new Error(`XML inválido en la línea ${line}: ${detail}`);
}
