/**
 * Puertos de salida del núcleo: contratos que los hosts implementan.
 *
 * El core define QUÉ necesita; el adaptador decide CÓMO (fetch global, proxy,
 * electron net) y los tests inyectan fakes sin mocks globales.
 */

/**
 * Emisor HTTP de una petición. `executeRequest` lo recibe por opciones con el
 * `fetch` global como default, de modo que el núcleo nunca llama a la red
 * directamente.
 */
export type HttpSender = (url: string, init: RequestInit) => Promise<Response>;
