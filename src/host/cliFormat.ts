import type { Collection, CollectionReport, Environment, Workspace } from "../core/types.ts";

/** Flujo de salida del CLI: `runCli` no toca `process`, solo esto. */
export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export type SessionReports = { collection: Collection; report: CollectionReport }[];

/** Informe `--json` para otra herramienta. */
export function toJson(workspace: Workspace, environment: Environment | null, reports: SessionReports) {
  return {
    ok: reports.every((entry) => entry.report.failed === 0),
    area: workspace.name,
    environment: environment?.name ?? null,
    environmentChanged: mergeChanged(reports),
    collections: reports.map(({ collection, report }) => ({
      id: collection.id,
      name: collection.name,
      passed: report.passed,
      failed: report.failed,
      environmentChanged: report.environmentChanged ?? {},
      steps: report.steps.map((step) => ({
        id: step.requestId,
        name: step.name,
        method: step.result.method,
        passed: step.passed,
        status: step.result.status,
        timeMs: step.result.timeMs,
        error: step.result.error,
        logs: step.result.logs ?? [],
        failedAssertions: step.result.assertions.filter((item) => !item.passed).map((item) => item.message),
      })),
    })),
  };
}

export function print(io: CliIo, workspace: Workspace, environment: Environment | null, reports: SessionReports): void {
  const area = environment ? `${workspace.name} · ambiente ${environment.name}` : workspace.name;
  io.out(`Área ${area}`);
  for (const { collection, report } of reports) {
    io.out("");
    io.out(`Colección ${collection.name}`);
    for (const step of report.steps) {
      const mark = step.passed ? "✓" : "✗";
      const where = step.result.error
        ? step.result.error
        : `${step.result.status ?? "—"} · ${step.result.timeMs} ms`;
      io.out(`  ${mark} ${step.result.method} ${step.name} — ${where}`);
      for (const line of step.result.logs ?? []) {
        io.out(`      · ${line}`);
      }
      for (const assertion of step.result.assertions) {
        if (assertion.passed) continue;
        io.out(`      ${assertion.message}`);
      }
    }
  }
  const passed = reports.reduce((total, entry) => total + entry.report.passed, 0);
  const failed = reports.reduce((total, entry) => total + entry.report.failed, 0);
  const changed = mergeChanged(reports);
  if (Object.keys(changed).length) io.out(`Ambiente actualizado: ${Object.keys(changed).join(", ")}`);
  io.out("");
  io.out(`Resultado: ${passed} bien, ${failed} falló`);
}

export function message(error: unknown): string {
  if (error instanceof SyntaxError) return `El archivo no es JSON válido (${error.message})`;
  return error instanceof Error ? error.message : String(error);
}

function mergeChanged(reports: { report: CollectionReport }[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const { report } of reports) Object.assign(merged, report.environmentChanged ?? {});
  return merged;
}
