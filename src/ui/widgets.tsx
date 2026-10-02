import type { ReactNode } from "react";
import { useRef } from "react";
import type { Pair } from "../core/types.ts";
import { pair } from "../core/factory.ts";

export function Mark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="14" width="5" height="14" rx="1" />
      <rect x="10" y="8" width="5" height="20" rx="1" />
      <rect x="17" y="11" width="5" height="17" rx="1" />
      <rect x="24" y="4" width="5" height="24" rx="1" />
    </svg>
  );
}

export function PairTable({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="pairs">
      {rows.map((row) => (
        <div className="pair" key={row.id}>
          <input
            type="checkbox"
            checked={row.enabled}
            aria-label="Usar fila"
            onChange={(event) => update(row.id, { enabled: event.target.checked })}
          />
          <input
            value={row.key}
            placeholder={keyPlaceholder}
            spellCheck={false}
            onChange={(event) => update(row.id, { key: event.target.value })}
          />
          <input
            value={row.value}
            placeholder={valuePlaceholder}
            spellCheck={false}
            type={row.secret || looksSecret(row.key) ? "password" : "text"}
            onChange={(event) => update(row.id, { value: event.target.value })}
          />
          <input
            type="checkbox"
            checked={row.secret === true}
            aria-label="Valor secreto"
            title="Oculta el valor en pantalla y lo exporta enmascarado"
            onChange={(event) => update(row.id, { secret: event.target.checked })}
          />
          <button type="button" className="icon" aria-label="Quitar" onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="add" onClick={() => onChange([...rows, pair()])}>
        Añadir
      </button>
    </div>
  );

  function update(id: string, patch: Partial<Pair>) {
    onChange(rows.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }
}

export function Spark({ values }: { values: number[] }) {
  const width = 360;
  const height = 72;
  if (values.length < 2) return <p className="hint">La gráfica aparece en cuanto llegan respuestas.</p>;
  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - 6 - (value / max) * (height - 12);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Peticiones por segundo">
      <polyline points={points} />
    </svg>
  );
}

export function JsonView({ text, query }: { text: string; query: string }) {
  const pretty = prettyJson(text);
  const needle = query.trim().toLowerCase();
  const lines = pretty.split("\n");
  const matched = needle ? lines.some((line) => line.toLowerCase().includes(needle)) : true;
  if (needle && !matched) return <p className="hint">Ninguna línea coincide.</p>;
  return (
    <pre className="code json">
      {lines.map((line, index) => (
        <div key={index} className={needle && !line.toLowerCase().includes(needle) ? "json-dim" : undefined}>
          {colorLine(line)}
        </div>
      ))}
    </pre>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

function colorLine(line: string) {
  const match = line.match(/^(\s*)("(?:\\.|[^"])*")(\s*:\s*)(.*)$/);
  if (!match) return <span className="json-plain">{line || " "}</span>;
  return (
    <>
      {match[1]}
      <span className="json-key">{match[2]}</span>
      {match[3]}
      <span className={valueClass(match[4] ?? "")}>{match[4]}</span>
    </>
  );
}

function valueClass(value: string): string {
  const trimmed = value.trim().replace(/,$/, "");
  if (trimmed.startsWith('"')) return "json-string";
  if (trimmed === "true" || trimmed === "false" || trimmed === "null") return "json-bool";
  if (/^-?\d/.test(trimmed)) return "json-number";
  return "json-plain";
}

export function prettyBody(text: string, binary: boolean): string {
  if (binary || !text) return text;
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value)} ms`;
}

/** Sugerencia: algunos nombres ya delatan una clave sin marcar a mano. */
function looksSecret(key: string): boolean {
  return /pass|token|secret|authorization/i.test(key);
}

export function formatWhen(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const delta = now - time;
  if (delta < 0) return new Date(time).toLocaleString("es");
  if (delta < 45_000) return "ahora";
  if (delta < 3_600_000) return `hace ${Math.max(1, Math.round(delta / 60_000))} min`;
  if (delta < 86_400_000) return `hace ${Math.round(delta / 3_600_000)} h`;
  return new Date(time).toLocaleString("es");
}

const SCRIPT_TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b(await|async|const|let|var|function|return|if|else|for|of|in|new|throw|try|catch|finally|true|false|null|undefined|typeof|instanceof)\b|\b(omnium)\b/g;

/** Tokenizador propio: comentarios, cadenas, números, palabras clave y la API. */
function highlight(code: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of code.matchAll(SCRIPT_TOKEN)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(code.slice(cursor, start));
    const className = match[1] ? "tok-com" : match[2] ? "tok-str" : match[3] ? "tok-num" : match[4] ? "tok-kw" : "tok-api";
    nodes.push(
      <span key={key++} className={className}>
        {match[0]}
      </span>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < code.length) nodes.push(code.slice(cursor));
  return nodes;
}

/**
 * Editor de scripts con resaltado propio: un `textarea` transparente encima de
 * un `pre` con el mismo texto tokenizado. Sin dependencias y sin ejecutar nada
 * mientras se escribe.
 */
export function ScriptEditor({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  return (
    <div className="script-block">
      <div className="script-label">
        <span>{label}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
      <div className="script-box">
        <pre className="script-code" aria-hidden="true" ref={preRef}>
          {highlight(value)}
        </pre>
        <textarea
          className="script-input"
          aria-label={label}
          value={value}
          spellCheck={false}
          placeholder="// omnium.log, omnium.test, omnium.variables…"
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            if (!preRef.current) return;
            preRef.current.scrollTop = event.currentTarget.scrollTop;
            preRef.current.scrollLeft = event.currentTarget.scrollLeft;
          }}
        />
      </div>
    </div>
  );
}
