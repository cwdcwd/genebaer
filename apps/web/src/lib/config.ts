/** Centralized backend connection config. */

export const API_URL: string =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4040";

/** WS endpoint derived from the HTTP API base (http→ws, https→wss). */
export const WS_URL: string =
  API_URL.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://") + "/ws";
