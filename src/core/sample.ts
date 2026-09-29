import { createRequest, pair } from "./factory.ts";
import type { Workspace } from "./types.ts";

export function sampleWorkspace(): Workspace {
  return {
    version: 1,
    name: "Omnium",
    activeEnvironmentId: "env-local",
    globals: [],
    environments: [
      {
        id: "env-local",
        name: "Local",
        variables: [pair("baseUrl", "http://127.0.0.1:4321", "var-base")],
      },
    ],
    collections: [
      {
        id: "col-demo",
        name: "Demostración",
        variables: [],
        requests: [
          createRequest({
            id: "req-health",
            name: "Salud",
            description: "Servidor de ejemplo. En la carpeta omnium: npm run demo",
            method: "GET",
            url: "{{baseUrl}}/health",
            assertions: [
              { id: "a-health-status", source: "status", op: "eq", path: "", expected: "200" },
              { id: "a-health-ok", source: "json", op: "eq", path: "$.ok", expected: "true" },
              { id: "a-health-time", source: "time", op: "lt", path: "", expected: "2000" },
            ],
          }),
          createRequest({
            id: "req-login",
            name: "Entrar",
            description: "Crea un token y lo deja listo para la siguiente petición.",
            method: "POST",
            url: "{{baseUrl}}/login",
            bodyMode: "json",
            bodyRaw: '{\n  "user": "ada"\n}',
            assertions: [
              { id: "a-login-status", source: "status", op: "eq", path: "", expected: "200" },
              { id: "a-login-token", source: "json", op: "exists", path: "$.token", expected: "" },
            ],
            extractors: [{ id: "x-token", name: "token", source: "json", path: "$.token" }],
          }),
          createRequest({
            id: "req-me",
            name: "Perfil",
            description: "Usa {{token}} extraído por Entrar cuando pruebas la colección completa.",
            method: "GET",
            url: "{{baseUrl}}/me",
            auth: { type: "bearer", token: "{{token}}" },
            assertions: [
              { id: "a-me-status", source: "status", op: "eq", path: "", expected: "200" },
              { id: "a-me-user", source: "json", op: "eq", path: "$.user", expected: "ada" },
              { id: "a-me-role", source: "json", op: "eq", path: "$.role", expected: "builder" },
            ],
          }),
        ],
      },
    ],
    history: [],
  };
}
