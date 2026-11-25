// Copied from jumpstarter-web (web/packages/api/src/http.ts) by scripts/sync-jumpstarter-web.sh: change it there.
/* eslint-disable */
// SPDX-License-Identifier: Apache-2.0
//
// Minimal structural types for the pieces of `fetch` and `WebSocket` the client uses, so that the
// browser's, Node's (22+) or a test's implementation is assignable without the DOM lib.

/** The parts of a `Response` the client reads. */
export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

/** The part of `Headers` the client reads. */
export interface HeadersLike {
  get(name: string): string | null;
}

/**
 * A complete fetch `Response`, as far as the HTTP tunnel needs it: a `ResponseLike` with its headers and `clone`.
 * The browser's `Response` is assignable to it, and it is that very object the tunnel hands to the plugin.
 */
export interface HttpResponseLike extends ResponseLike {
  readonly headers: HeadersLike;
  clone(): HttpResponseLike;
}

/** The request options the client passes. The loose field types keep `typeof fetch` assignable. */
export interface RequestInitLike {
  method?: string;
  headers?: unknown;
  body?: unknown;
  credentials?: unknown;
  signal?: unknown;
}

/** `fetch`. The method-style signature makes the parameters bivariant, which `typeof fetch` needs. */
export type FetchLike = {
  bivarianceHack(url: string, init?: RequestInitLike): Promise<ResponseLike>;
}["bivarianceHack"];

/** What an event from a WebSocket carries; real events have more, all of it optional here. */
export interface WebSocketEventLike {
  readonly type?: string;
  readonly data?: unknown;
  readonly code?: number;
}

/** The parts of a `WebSocket` the client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void;
}

/** `WebSocket`'s constructor; in Node the caller can pass one that adds headers. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

/** Where the API lives when it is not the page's own origin. */
export interface LocationLike {
  readonly protocol: string;
  readonly host: string;
}

/** `WebSocket.readyState` values. */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;

/** The globals the client falls back to, read without the DOM lib. */
export interface HostGlobals {
  fetch?: FetchLike;
  WebSocket?: WebSocketConstructor;
  location?: LocationLike;
  setTimeout?: (callback: () => void, ms: number) => unknown;
}

function isFunctionOrAbsent(value: unknown): boolean {
  return value === undefined || typeof value === "function";
}

function isLocationOrAbsent(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "protocol") === "string" &&
    typeof Reflect.get(value, "host") === "string"
  );
}

/** True when every global the client reads is absent or what the client expects it to be. */
function isHostGlobals(value: unknown): value is HostGlobals {
  if (typeof value !== "object" || value === null) return false;
  return (
    isFunctionOrAbsent(Reflect.get(value, "fetch")) &&
    isFunctionOrAbsent(Reflect.get(value, "WebSocket")) &&
    isLocationOrAbsent(Reflect.get(value, "location")) &&
    isFunctionOrAbsent(Reflect.get(value, "setTimeout"))
  );
}

/**
 * The global object, read as `HostGlobals`: its properties are looked up when they are used, so a
 * `fetch` that is installed after the client was created is still found.
 */
export function hostGlobals(): HostGlobals {
  const host: unknown = globalThis;
  return isHostGlobals(host) ? host : {};
}
