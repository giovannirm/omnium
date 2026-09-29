import { stepPassed } from "./assertions.ts";
import type { CookieJar } from "./cookies.ts";
import { executeRequest } from "./execute.ts";
import type { CollectionReport, RequestModel } from "./types.ts";

export { stepPassed } from "./assertions.ts";

export async function runCollection(options: {
  requests: RequestModel[];
  variables: Record<string, string>;
  jar?: CookieJar;
  signal?: AbortSignal;
}): Promise<CollectionReport> {
  const variables = { ...options.variables };
  const steps: CollectionReport["steps"] = [];

  for (const request of options.requests) {
    if (options.signal?.aborted) break;
    const result = await executeRequest({
      request,
      variables,
      jar: options.jar,
      signal: options.signal,
    });
    Object.assign(variables, result.ok ? result.extracted : {});
    steps.push({
      requestId: request.id,
      name: request.name,
      passed: stepPassed(result),
      result,
    });
  }

  const passed = steps.filter((step) => step.passed).length;
  return { steps, passed, failed: steps.length - passed, variables };
}
