import type { Client } from "./client.ts";

declare global {
  interface Window {
    omnium?: Client;
  }
}

export {};
