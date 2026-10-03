import { stepPassed } from "./assertions.ts";
import type { CookieJar } from "./cookies.ts";
import { executeRequest, type ScriptBinding } from "./execute.ts";
import type { CollectionReport, RequestModel } from "./types.ts";
import { diffRecords } from "./variables.ts";

export { stepPassed } from "./assertions.ts";

export async function runCollection(options: {
  requests: RequestModel[];
  variables: Record<string, string>;
  jar?: CookieJar;
  signal?: AbortSignal;
  /** Hooks del ambiente/colección y su capa ambiente; cada paso los recibe
   * junto con su propio script de petición. */
  scripts?: ScriptBinding;
}): Promise<CollectionReport> {
  const variables = { ...options.variables };
  const environment = { ...(options.scripts?.environment ?? {}) };
  const steps: CollectionReport["steps"] = [];

  for (const request of options.requests) {
    if (options.signal?.aborted) break;
    const result = await executeRequest({
      request,
      variables,
      jar: options.jar,
      signal: options.signal,
      scripts: options.scripts ? { ...options.scripts, environment } : undefined,
    });
    Object.assign(variables, result.extracted);
    if (result.environmentChanged) Object.assign(environment, result.environmentChanged);
    steps.push({
      requestId: request.id,
      name: request.name,
      passed: stepPassed(result),
      result,
    });
  }

  const passed = steps.filter((step) => step.passed).length;
  const environmentChanged = diffRecords(options.scripts?.environment ?? {}, environment);
  return {
    steps,
    passed,
    failed: steps.length - passed,
    variables,
    ...(Object.keys(environmentChanged).length ? { environmentChanged } : {}),
  };
}
