import assert from "node:assert/strict";
import { test } from "node:test";
import { executeRequest } from "./execute.ts";
import { createRequest } from "./factory.ts";
import type { HttpSender } from "./ports.ts";

type SendCall = { url: string; init: RequestInit };

function fakeSender(): { send: HttpSender; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const send: HttpSender = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { send, calls };
}

test("un pre que falla aborta antes de la red: el emisor no se invoca", async () => {
  const { send, calls } = fakeSender();
  const result = await executeRequest({
    request: createRequest({
      url: "https://example.test/api",
      preScript: 'throw new Error("boom")',
    }),
    variables: {},
    send,
  });
  assert.equal(calls.length, 0);
  assert.match(result.error ?? "", /script de la petición: boom/);
  assert.equal(result.status, null);
});

test("el emisor recibe la petición preparada y el resultado vuelve completo", async () => {
  const { send, calls } = fakeSender();
  const result = await executeRequest({
    request: createRequest({ url: "https://example.test/api?x=1", method: "POST" }),
    variables: { who: "ada" },
    send,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/api?x=1");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(result.status, 200);
  assert.equal(result.error, null);
  assert.equal(result.ok, true);
  assert.deepEqual(result.bodyJson, {});
});

test("un post que falla deja la respuesta intacta y una aserción fallida", async () => {
  const { send } = fakeSender();
  const result = await executeRequest({
    request: createRequest({
      url: "https://example.test/api",
      postScript:
        'omnium.test("debe fallar", () => omnium.expect(1).toBe(2))',
    }),
    variables: {},
    send,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.bodyJson, {});
  assert.equal(result.ok, false);
  assert.equal(result.assertions.length, 1);
  assert.equal(result.assertions[0].id, "script:1");
  assert.equal(result.assertions[0].passed, false);
});
