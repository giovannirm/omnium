import { useState } from "react";
import type { CollectionReport, ExecutionResult, LoadPlan, LoadSnapshot } from "../core/types.ts";
import { clampPlan, judgeLoad } from "../core/load.ts";
import { JsonView, Spark, formatBytes, formatMs, prettyBody } from "./widgets.tsx";

export function Outcome({
  pane,
  onPane,
  result,
  report,
  load,
  plan,
  onPlan,
  onStart,
  onStop,
  busy,
  onPickStep,
  onCopy,
}: {
  pane: "response" | "tests" | "load";
  onPane: (pane: "response" | "tests" | "load") => void;
  result: ExecutionResult | null;
  report: { collectionId: string; report: CollectionReport } | null;
  load: { running: boolean; points: number[]; snap: LoadSnapshot | null };
  plan: LoadPlan;
  onPlan: (plan: LoadPlan) => void;
  onStart: () => void;
  onStop: () => void;
  busy: boolean;
  onPickStep: (requestId: string) => void;
  onCopy: (text: string) => void;
}) {
  const snap = load.snap;
  return (
    <aside className="outcome">
      <div className="toolbar">
        {(
          [
            ["response", "Respuesta"],
            ["tests", "Pruebas"],
            ["load", "Carga"],
          ] as const
        ).map(([id, label]) => (
          <button type="button" key={id} className={pane === id ? "tab active" : "tab"} onClick={() => onPane(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="outcome-body">
        {pane === "response" ? <ResponseView result={result} onCopy={onCopy} /> : null}
        {pane === "tests" ? <TestsView result={result} report={report} onPickStep={onPickStep} /> : null}
        {pane === "load" ? (
          <div className="stack">
            <div className="load-form">
              <NumberField label="Usuarios" value={plan.concurrency} min={1} max={100} onChange={(concurrency) => onPlan({ ...plan, concurrency })} />
              <NumberField
                label="Subida (s)"
                value={plan.rampUpMs / 1000}
                min={0}
                max={plan.durationMs / 1000}
                onChange={(seconds) => onPlan({ ...plan, rampUpMs: seconds * 1000 })}
              />
              <NumberField
                label="Duración (s)"
                value={plan.durationMs / 1000}
                min={0.5}
                max={180}
                onChange={(seconds) => onPlan({ ...plan, durationMs: seconds * 1000 })}
              />
              <NumberField label="Pausa (ms)" value={plan.pauseMs} min={0} max={10000} onChange={(pauseMs) => onPlan({ ...plan, pauseMs })} />
              <NumberField label="Límite (ms)" value={plan.timeoutMs} min={50} max={60000} onChange={(timeoutMs) => onPlan({ ...plan, timeoutMs })} />
              <NumberField label="Error máx %" value={plan.maxErrorPct} min={0} max={100} onChange={(maxErrorPct) => onPlan({ ...plan, maxErrorPct })} />
              <NumberField label="p95 máx (ms)" value={plan.maxP95Ms} min={0} max={120000} onChange={(maxP95Ms) => onPlan({ ...plan, maxP95Ms })} />
            </div>
            <p className="hint">Hasta 100 usuarios. Un 4xx, un 5xx o un tiempo límite agotado cuenta como fallo. La duración incluye la subida. p95 en 0 no pone límite de tiempo.</p>
            {load.running ? (
              <button type="button" className="send danger-fill" onClick={onStop}>
                Detener
              </button>
            ) : (
              <button type="button" className="send" data-testid="load-start" onClick={onStart} disabled={busy}>
                Iniciar carga
              </button>
            )}
            {snap ? (
              <>
                {load.running ? (
                  <p className="hint">
                    {Math.round(snap.elapsedMs / 100) / 10}s de {plan.durationMs / 1000}s · {snap.inflight} en curso · {snap.sent} respuestas
                  </p>
                ) : (
                  <Verdict snap={snap} plan={plan} />
                )}
                <div className="stats">
                  <Stat label="req/s" value={String(Math.round(snap.rps))} />
                  <Stat label="errores" value={snap.sent ? `${Math.round((snap.failed / snap.sent) * 1000) / 10}%` : "0%"} />
                  <Stat label="p50" value={formatMs(snap.p50)} />
                  <Stat label="p95" value={formatMs(snap.p95)} />
                  <Stat label="p99" value={formatMs(snap.p99)} />
                  <Stat label="ok" value={String(snap.ok)} />
                </div>
                <Spark values={load.points} />
                <p className="hint">
                  {snap.sent} respuestas · mín {formatMs(snap.minMs)} · máx {formatMs(snap.maxMs)} · media {formatMs(snap.avgMs)}
                  {snap.stopped ? " · detenida" : ""}
                  {snap.samplesCapped ? " · percentiles sobre las primeras 50 000" : ""}
                </p>
                {snap.errors.length > 0 ? (
                  <ul className="errors">
                    {snap.errors.map((error) => (
                      <li key={error.message}>
                        <b>{error.count}</b> {error.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="hint">La carga repite la petición actual con varios usuarios a la vez.</p>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function ResponseView({ result, onCopy }: { result: ExecutionResult | null; onCopy: (text: string) => void }) {
  const [query, setQuery] = useState("");
  if (!result) return <p className="hint">Envía una petición para ver el estado, el tiempo y el cuerpo.</p>;
  const body = prettyBody(result.bodyText, result.binary);
  return (
    <div className="stack">
      {result.error ? <p className="banner bad">{result.error}</p> : null}
      {result.truncated ? <p className="banner">El cuerpo se recortó a 1 MB para no bloquear la aplicación.</p> : null}
      <div className="status-line">
        <span data-testid="status" className={statusClass(result.status)}>
          {result.status ?? "—"} {result.statusText}
        </span>
        <span>{formatMs(result.timeMs)}</span>
        <span>{formatBytes(result.sizeBytes)}</span>
        <button type="button" className="ghost" onClick={() => onCopy(body)}>
          Copiar
        </button>
      </div>
      {result.finalUrl && result.finalUrl !== result.url ? <p className="hint">{result.finalUrl}</p> : null}
      {Object.keys(result.extracted).length > 0 ? (
        <div className="chips">
          {Object.entries(result.extracted).map(([key, value]) => (
            <span key={key} className="chip">
              {key}={value}
            </span>
          ))}
        </div>
      ) : null}
      <input className="search-inline" value={query} placeholder="Filtrar el cuerpo" onChange={(event) => setQuery(event.target.value)} />
      {result.binary ? <pre className="code">{body}</pre> : <JsonView text={result.bodyText || "Sin cuerpo"} query={query} />}
      <table className="headers">
        <tbody>
          {result.headers.map((header, index) => (
            <tr key={`${header.name}-${index}`}>
              <th>{header.name}</th>
              <td>{header.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TestsView({
  result,
  report,
  onPickStep,
}: {
  result: ExecutionResult | null;
  report: { collectionId: string; report: CollectionReport } | null;
  onPickStep: (requestId: string) => void;
}) {
  return (
    <div className="stack">
      {report ? (
        <div className="stack">
          <p className={report.report.failed ? "banner bad" : "banner"}>
            {report.report.passed} bien · {report.report.failed} mal
          </p>
          {report.report.steps.map((step) => (
            <button type="button" key={step.requestId} className={step.passed ? "report-row" : "report-row bad"} onClick={() => onPickStep(step.requestId)}>
              <b>{step.passed ? "OK" : "Fallo"}</b>
              <span>{step.name}</span>
              <small>
                {step.result.status ?? "—"} · {formatMs(step.result.timeMs)}
              </small>
            </button>
          ))}
        </div>
      ) : null}
      {result?.assertions.length ? (
        <ul className="assert-results">
          {result.assertions.map((item) => (
            <li key={item.id} className={item.passed ? "ok" : "bad"}>
              {item.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Añade afirmaciones en la pestaña Pruebas y pulsa Probar.</p>
      )}
      {result?.logs?.length ? (
        <div className="script-logs">
          <p className="hint">Salida de los scripts</p>
          <ul>
            {result.logs.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Verdict({ snap, plan }: { snap: LoadSnapshot; plan: LoadPlan }) {
  const verdict = judgeLoad(snap, clampPlan(plan));
  return <p className={verdict.passed ? "banner" : "banner bad"}>{verdict.passed ? "La carga cumple los límites" : verdict.notes.join(" · ")}</p>;
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={label.includes("(s)") ? 0.5 : 1}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function statusClass(status: number | null): string {
  if (status === null) return "status bad";
  if (status < 300) return "status ok";
  if (status < 400) return "status warn";
  return "status bad";
}
