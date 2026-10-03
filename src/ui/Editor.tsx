import { useState } from "react";
import { METHODS } from "../core/types.ts";
import type { Assertion, Environment, RequestModel } from "../core/types.ts";
import { OP_LABEL, OPS_FOR } from "../core/assertions.ts";
import { assertion, blankAuth, uid } from "../core/factory.ts";
import { collectPlaceholders } from "../core/variables.ts";
import { PairTable, ScriptEditor } from "./widgets.tsx";

const TABS = [
  ["params", "Parámetros"],
  ["headers", "Cabeceras"],
  ["body", "Cuerpo"],
  ["auth", "Auth"],
  ["tests", "Pruebas"],
  ["scripts", "Scripts"],
] as const;

type Tab = (typeof TABS)[number][0];

export function Editor({
  request,
  variables,
  runtime,
  pending,
  onChange,
  onSend,
  onCancel,
  onTest,
  onCurl,
  onSnippet,
  onNotice,
  onDelete,
  onDuplicate,
  onMove,
  onClearRuntime,
}: {
  request: RequestModel;
  variables: Record<string, string>;
  runtime: Record<string, string>;
  pending: boolean;
  onChange: (request: RequestModel) => void;
  onSend: () => void;
  onCancel: () => void;
  onTest: () => void;
  onCurl: () => void;
  onSnippet: () => void;
  onNotice: (message: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (delta: number) => void;
  onClearRuntime: () => void;
}) {
  const [tab, setTab] = useTab();
  const names = collectPlaceholders(request);
  const runtimeNames = Object.keys(runtime);
  return (
    <section className="stage">
      <input
        className="request-title"
        value={request.name}
        aria-label="Nombre de la petición"
        onChange={(event) => onChange({ ...request, name: event.target.value })}
      />
      <input
        className="request-desc"
        value={request.description}
        placeholder="Nota de esta petición"
        onChange={(event) => onChange({ ...request, description: event.target.value })}
      />
      {request.url.includes("127.0.0.1:4321") ? (
        <p className="banner">Esta petición usa el servidor de ejemplo. En otra terminal, dentro de omnium: npm run demo</p>
      ) : null}
      <div className="url-row">
        <select
          className={`method-select method-${request.method}`}
          value={request.method}
          aria-label="Método"
          onChange={(event) => onChange({ ...request, method: event.target.value as RequestModel["method"] })}
        >
          {METHODS.map((method) => (
            <option key={method}>{method}</option>
          ))}
        </select>
        <input
          data-testid="url"
          className="url-input"
          value={request.url}
          placeholder="https://api.ejemplo.com/recurso"
          spellCheck={false}
          onChange={(event) => onChange({ ...request, url: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <button
          type="button"
          className={pending ? "send danger-fill" : "send"}
          data-testid="send"
          onClick={pending ? onCancel : onSend}
          title={pending ? "Cancelar" : "Enviar (⌘↩)"}
        >
          {pending ? "Cancelar" : "Enviar"}
        </button>
      </div>
      <div className="chips">
        {names.map((name) => (
          <span key={name} className={name in variables ? "chip" : "chip missing"}>
            {name}
          </span>
        ))}
        {runtimeNames.length > 0 ? (
          <button type="button" className="text-btn" onClick={onClearRuntime}>
            Limpiar corrida
          </button>
        ) : null}
      </div>
      <div className="toolbar">
        {TABS.map(([id, label]) => (
          <button type="button" key={id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {label}
            {id === "tests" && request.assertions.length ? ` ${request.assertions.length}` : ""}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <button type="button" className="ghost" onClick={onTest} data-testid="test" disabled={pending}>
          Probar
        </button>
        <button type="button" className="ghost" onClick={onSnippet}>
          Código
        </button>
        <button type="button" className="ghost" onClick={onCurl}>
          cURL
        </button>
        <button type="button" className="ghost" onClick={() => onMove(-1)}>
          Subir
        </button>
        <button type="button" className="ghost" onClick={() => onMove(1)}>
          Bajar
        </button>
        <button type="button" className="ghost" onClick={onDuplicate}>
          Duplicar
        </button>
        <button type="button" className="ghost danger" onClick={onDelete}>
          Eliminar
        </button>
      </div>
      <div className="panel">
        {tab === "params" ? (
          <PairTable
            rows={request.params}
            keyPlaceholder="clave"
            valuePlaceholder="valor"
            onChange={(params) => onChange({ ...request, params })}
          />
        ) : null}
        {tab === "headers" ? (
          <>
            <PairTable
              rows={request.headers}
              keyPlaceholder="Cabecera"
              valuePlaceholder="Valor"
              onChange={(headers) => onChange({ ...request, headers })}
            />
            <p className="hint">Si no las pones, Omnium añade Accept y User-Agent.</p>
          </>
        ) : null}
        {tab === "body" ? <BodyEditor request={request} onChange={onChange} onNotice={onNotice} /> : null}
        {tab === "auth" ? <AuthEditor request={request} onChange={onChange} /> : null}
        {tab === "tests" ? <TestsEditor request={request} onChange={onChange} /> : null}
        {tab === "scripts" ? (
          <div className="scripts-panel">
            <ScriptEditor
              label="Pre (antes de enviar)"
              hint="Prepara variables, cabeceras o el cuerpo: omnium.variables.set, omnium.request…"
              value={request.preScript ?? ""}
              onChange={(preScript) => onChange({ ...request, preScript })}
            />
            <ScriptEditor
              label="Post (con la respuesta)"
              hint="Valida con omnium.test y guarda datos con omnium.variables.set; omnium.response lee la respuesta."
              value={request.postScript ?? ""}
              onChange={(postScript) => onChange({ ...request, postScript })}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function EnvironmentEditor({
  environment,
  active,
  onChange,
  onUse,
  onDelete,
}: {
  environment: Environment;
  active: boolean;
  onChange: (environment: Environment) => void;
  onUse: () => void;
  onDelete: () => void;
}) {
  return (
    <section className="stage">
      <input
        className="request-title"
        value={environment.name}
        aria-label="Nombre del ambiente"
        onChange={(event) => onChange({ ...environment, name: event.target.value })}
      />
      <p className="hint">Las variables se escriben como {"{{nombre}}"} en la URL, cabeceras, cuerpo y auth.</p>
      <div className="toolbar">
        <button type="button" className="send" onClick={onUse} disabled={active}>
          {active ? "Ambiente activo" : "Usar este ambiente"}
        </button>
        <button type="button" className="ghost danger" onClick={onDelete}>
          Eliminar
        </button>
      </div>
      <div className="panel">
        <PairTable
          rows={environment.variables}
          keyPlaceholder="nombre"
          valuePlaceholder="valor"
          onChange={(variables) => onChange({ ...environment, variables })}
        />
      </div>
      <div className="scripts-panel">
        <ScriptEditor
          label="Pre del ambiente"
          hint="Corre al principio de cada envío y de cada prueba de colección."
          value={environment.preScript ?? ""}
          onChange={(preScript) => onChange({ ...environment, preScript })}
        />
        <ScriptEditor
          label="Post del ambiente"
          hint="Corre al final, después de los scripts de la colección y de la petición."
          value={environment.postScript ?? ""}
          onChange={(postScript) => onChange({ ...environment, postScript })}
        />
      </div>
    </section>
  );
}

function BodyEditor({
  request,
  onChange,
  onNotice,
}: {
  request: RequestModel;
  onChange: (request: RequestModel) => void;
  onNotice: (message: string) => void;
}) {
  return (
    <div className="stack">
      <div className="segmented">
        {(["none", "json", "text", "form"] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            className={request.bodyMode === mode ? "tab active" : "tab"}
            onClick={() => onChange({ ...request, bodyMode: mode })}
          >
            {mode === "none" ? "Ninguno" : mode === "json" ? "JSON" : mode === "text" ? "Texto" : "Formulario"}
          </button>
        ))}
        {request.bodyMode === "json" ? (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              try {
                onChange({ ...request, bodyRaw: JSON.stringify(JSON.parse(request.bodyRaw) as unknown, null, 2) });
              } catch {
                onNotice("El cuerpo no es JSON válido");
              }
            }}
          >
            Formatear
          </button>
        ) : null}
      </div>
      {request.method === "GET" || request.method === "HEAD" ? <p className="hint">Este método no envía cuerpo.</p> : null}
      {request.bodyMode === "form" ? (
        <PairTable rows={request.form} keyPlaceholder="campo" valuePlaceholder="valor" onChange={(form) => onChange({ ...request, form })} />
      ) : null}
      {request.bodyMode === "json" || request.bodyMode === "text" ? (
        <textarea
          className="code-input"
          value={request.bodyRaw}
          spellCheck={false}
          onChange={(event) => onChange({ ...request, bodyRaw: event.target.value })}
        />
      ) : null}
    </div>
  );
}

function AuthEditor({ request, onChange }: { request: RequestModel; onChange: (request: RequestModel) => void }) {
  const auth = request.auth;
  return (
    <div className="stack">
      <label className="field">
        Tipo
        <select
          value={auth.type}
          onChange={(event) => onChange({ ...request, auth: blankAuth(event.target.value as typeof auth.type) })}
        >
          <option value="none">Sin auth</option>
          <option value="bearer">Bearer</option>
          <option value="basic">Basic</option>
          <option value="apikey">Clave de API</option>
        </select>
      </label>
      {auth.type === "bearer" ? (
        <label className="field">
          Token
          <input value={auth.token} spellCheck={false} onChange={(event) => onChange({ ...request, auth: { ...auth, token: event.target.value } })} />
        </label>
      ) : null}
      {auth.type === "basic" ? (
        <div className="split">
          <label className="field">
            Usuario
            <input value={auth.username} onChange={(event) => onChange({ ...request, auth: { ...auth, username: event.target.value } })} />
          </label>
          <label className="field">
            Contraseña
            <input
              type="password"
              value={auth.password}
              onChange={(event) => onChange({ ...request, auth: { ...auth, password: event.target.value } })}
            />
          </label>
        </div>
      ) : null}
      {auth.type === "apikey" ? (
        <div className="split">
          <label className="field">
            Nombre
            <input value={auth.key} onChange={(event) => onChange({ ...request, auth: { ...auth, key: event.target.value } })} />
          </label>
          <label className="field">
            Valor
            <input value={auth.value} onChange={(event) => onChange({ ...request, auth: { ...auth, value: event.target.value } })} />
          </label>
          <label className="field">
            En
            <select value={auth.in} onChange={(event) => onChange({ ...request, auth: { ...auth, in: event.target.value as "header" | "query" } })}>
              <option value="header">Cabecera</option>
              <option value="query">Query</option>
            </select>
          </label>
        </div>
      ) : null}
    </div>
  );
}

const OP_SHORT: Record<Assertion["op"], string> = {
  eq: "=",
  neq: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  contains: "contiene",
  exists: "existe",
};

function TestsEditor({ request, onChange }: { request: RequestModel; onChange: (request: RequestModel) => void }) {
  return (
    <div className="stack">
      <p className="hint">Al probar la colección, las variables extraídas pasan a la petición siguiente.</p>
      {request.assertions.map((item) => {
        const showPath = item.source === "json" || item.source === "header";
        const showExpected = item.op !== "exists";
        return (
        <div
          className="assert-row"
          key={item.id}
          style={{ gridTemplateColumns: ["132px", "88px", showPath ? "minmax(0,1fr)" : "", showExpected ? "minmax(0,1fr)" : "", "28px"].filter(Boolean).join(" ") }}
        >
          <select value={item.source} onChange={(event) => patchAssertion(item, { source: event.target.value as Assertion["source"] })}>
            <option value="status">Estado</option>
            <option value="time">Tiempo</option>
            <option value="json">JSON</option>
            <option value="header">Cabecera</option>
            <option value="body">Cuerpo</option>
          </select>
          <select title={OP_LABEL[item.op]} value={item.op} onChange={(event) => patchAssertion(item, { op: event.target.value as Assertion["op"] })}>
            {OPS_FOR[item.source].map((op) => (
              <option key={op} value={op}>
                {OP_SHORT[op]}
              </option>
            ))}
          </select>
          {showPath ? (
            <input
              value={item.path}
              placeholder={item.source === "json" ? "$.data.id" : "content-type"}
              spellCheck={false}
              onChange={(event) => patchAssertion(item, { path: event.target.value })}
            />
          ) : null}
          {showExpected ? (
            <input
              value={item.expected}
              placeholder="esperado"
              spellCheck={false}
              onChange={(event) => patchAssertion(item, { expected: event.target.value })}
            />
          ) : null}
          <button
            type="button"
            className="icon"
            aria-label="Quitar afirmación"
            onClick={() => onChange({ ...request, assertions: request.assertions.filter((row) => row.id !== item.id) })}
          >
            ×
          </button>
        </div>
        );
      })}
      <button type="button" className="add" onClick={() => onChange({ ...request, assertions: [...request.assertions, assertion()] })}>
        Añadir afirmación
      </button>
      <h3>Extraer variables</h3>
      {request.extractors.map((item) => (
        <div className="assert-row" key={item.id}>
          <input
            value={item.name}
            placeholder="nombre"
            spellCheck={false}
            onChange={(event) =>
              onChange({
                ...request,
                extractors: request.extractors.map((row) => (row.id === item.id ? { ...row, name: event.target.value } : row)),
              })
            }
          />
          <select
            value={item.source}
            onChange={(event) =>
              onChange({
                ...request,
                extractors: request.extractors.map((row) =>
                  row.id === item.id ? { ...row, source: event.target.value as "json" | "header" } : row,
                ),
              })
            }
          >
            <option value="json">JSON</option>
            <option value="header">Cabecera</option>
          </select>
          <input
            value={item.path}
            placeholder={item.source === "json" ? "$.token" : "x-request-id"}
            spellCheck={false}
            onChange={(event) =>
              onChange({
                ...request,
                extractors: request.extractors.map((row) => (row.id === item.id ? { ...row, path: event.target.value } : row)),
              })
            }
          />
          <button
            type="button"
            className="icon"
            aria-label="Quitar extractor"
            onClick={() => onChange({ ...request, extractors: request.extractors.filter((row) => row.id !== item.id) })}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="add"
        onClick={() =>
          onChange({
            ...request,
            extractors: [...request.extractors, { id: uid("extract"), name: "", source: "json", path: "$." }],
          })
        }
      >
        Añadir extractor
      </button>
      <div className="split">
        <label className="field">
          Tiempo límite (ms)
          <input
            type="number"
            min={50}
            max={120000}
            value={request.timeoutMs}
            onChange={(event) => onChange({ ...request, timeoutMs: Number(event.target.value) })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={request.followRedirects}
            onChange={(event) => onChange({ ...request, followRedirects: event.target.checked })}
          />
          Seguir redirecciones
        </label>
      </div>
    </div>
  );

  function patchAssertion(item: Assertion, patch: Partial<Assertion>) {
    const next = { ...item, ...patch };
    const ops = OPS_FOR[next.source];
    if (!ops.includes(next.op)) next.op = ops[0] ?? "eq";
    onChange({ ...request, assertions: request.assertions.map((row) => (row.id === item.id ? next : row)) });
  }
}

function useTab(): [Tab, (tab: Tab) => void] {
  return useState<Tab>("params");
}

