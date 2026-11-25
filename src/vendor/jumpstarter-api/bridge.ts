// Copied from jumpstarter-web (web/packages/api/src/bridge.ts) by scripts/sync-jumpstarter-web.sh: change it there.
/* eslint-disable */
// SPDX-License-Identifier: Apache-2.0
//
// The bridge: the API of a lease carried over messages, not over HTTP (docs/bridge.md).
//
// `jumpstarter-web bridge` runs inside a lease and speaks length-prefixed frames on its standard input and
// output. A host with windows of its own (an editor's extension, an agentic IDE's plugin) starts it and shows the
// device in its own tabs and panels. This module is everything such a host needs that is not about its windows:
//
// * the frames (`encodeBridgeFrame`, `BridgeFrameDecoder`), for the process that holds the pipes;
// * `BridgeHub`: one bridge shared by several views, each with a `BridgePort` whose requests and channels are
//   its own and end with it;
// * `bridgeTransport(port)`: a `fetch` and a `WebSocket` over a port, which is all `createApiClient` asks for.
//   The API client, and so every view written against it, runs unchanged on a bridge.
//
// A port carries plain objects (with a `Uint8Array` for binary data), so it crosses whatever the host has
// between the process and the view: `postMessage` into a webview, a plugin's socket, nothing at all.

import type {
  FetchLike,
  HttpResponseLike,
  RequestInitLike,
  WebSocketConstructor,
  WebSocketEventLike,
  WebSocketLike,
} from "./http.js";

/** The protocol a bridge says it speaks in its `ready` message. */
export const BRIDGE_PROTOCOL = "jumpstarter.bridge/1";

const KIND_JSON = 0;
const KIND_BINARY = 1;
/** The largest frame either side sends. */
export const BRIDGE_MAX_FRAME_BYTES = 32 * 1024 * 1024;

type Bytes = Uint8Array<ArrayBuffer>;
/** A request's id, and what a port may use for one. */
export type BridgeId = number | string;

/** How a body travels: JSON as JSON, text as text, anything else in base64. One of the three, or none. */
export interface BridgeBody {
  json?: unknown;
  text?: string;
  base64?: string;
}

/** What a host sends. `binary` is a channel's binary data: a frame of its own on the pipe. */
export type BridgeOutgoing =
  | ({ op: "request"; id: BridgeId; method: string; path: string; headers?: Record<string, string> } & BridgeBody)
  | { op: "cancel"; id: BridgeId }
  | { op: "open"; channel: number; path: string; protocols?: string[] }
  | { op: "text"; channel: number; data: string }
  | { op: "binary"; channel: number; data: Bytes }
  | { op: "close"; channel: number; code?: number };

/** What a bridge sends. */
export type BridgeIncoming =
  | { event: "ready"; protocol: string; version?: string; mode?: string; roles?: string[] }
  | ({ event: "response"; id: BridgeId; status: number; headers?: Record<string, string> } & BridgeBody)
  | { event: "open"; channel: number; protocol?: string }
  | { event: "text"; channel: number; data: string }
  | { event: "binary"; channel: number; data: Bytes }
  | { event: "close"; channel: number; code?: number; reason?: string }
  | { event: "refused"; channel: number; status: number; json?: unknown }
  | { event: "error"; code?: string; message?: string };

// ---------------------------------------------------------------- text and base64, without a platform's help

/** UTF-8 of a string. (The library is built without the DOM's or Node's types: `TextEncoder` is neither's alone.) */
export function utf8Encode(text: string): Bytes {
  const out: number[] = [];
  for (const symbol of text) {
    const code = symbol.codePointAt(0) ?? 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** The string of UTF-8 bytes; what is not UTF-8 becomes U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk: number[] = [];
  const flush = (): void => {
    if (chunk.length > 0) parts.push(String.fromCodePoint(...chunk));
    chunk = [];
  };
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i++] ?? 0;
    let code = 0xfffd;
    const more = lead < 0x80 ? 0 : lead >> 5 === 0b110 ? 1 : lead >> 4 === 0b1110 ? 2 : lead >> 3 === 0b11110 ? 3 : -1;
    if (more === 0) code = lead;
    else if (more > 0 && i + more <= bytes.length) {
      let value = lead & (0xff >> (more + 2));
      let valid = true;
      for (let k = 0; k < more; k++) {
        const next = bytes[i + k] ?? 0;
        if (next >> 6 !== 0b10) valid = false;
        value = (value << 6) | (next & 0x3f);
      }
      if (valid && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)) {
        code = value;
        i += more;
      }
    }
    chunk.push(code);
    if (chunk.length >= 4096) flush();
  }
  flush();
  return parts.join("");
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    parts.push(
      BASE64.charAt(a >> 2),
      BASE64.charAt(((a & 3) << 4) | (b >> 4)),
      i + 1 < bytes.length ? BASE64.charAt(((b & 15) << 2) | (c >> 6)) : "=",
      i + 2 < bytes.length ? BASE64.charAt(c & 63) : "=",
    );
  }
  return parts.join("");
}

export function base64Decode(text: string): Bytes {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (BASE64.indexOf(clean.charAt(i)) << 18) |
      (BASE64.indexOf(clean.charAt(i + 1)) << 12) |
      ((i + 2 < clean.length ? BASE64.indexOf(clean.charAt(i + 2)) : 0) << 6) |
      (i + 3 < clean.length ? BASE64.indexOf(clean.charAt(i + 3)) : 0);
    if (at < out.length) out[at++] = (n >> 16) & 0xff;
    if (at < out.length) out[at++] = (n >> 8) & 0xff;
    if (at < out.length) out[at++] = n & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------- frames

function frame(kind: number, head: Uint8Array, body: Uint8Array): Bytes {
  const length = 1 + head.length + body.length;
  if (length > BRIDGE_MAX_FRAME_BYTES)
    throw new Error(`a frame of ${String(length)} bytes is larger than the bridge takes`);
  const out = new Uint8Array(4 + length);
  new DataView(out.buffer).setUint32(0, length);
  out[4] = kind;
  out.set(head, 5);
  out.set(body, 5 + head.length);
  return out;
}

/** The bytes of one message, as they go into the bridge's input. */
export function encodeBridgeFrame(message: BridgeOutgoing): Bytes {
  if (message.op === "binary") {
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, message.channel);
    return frame(KIND_BINARY, head, message.data);
  }
  return frame(KIND_JSON, new Uint8Array(0), utf8Encode(JSON.stringify(message)));
}

function isIncoming(value: unknown): value is BridgeIncoming {
  return typeof value === "object" && value !== null && "event" in value && typeof value.event === "string";
}

/** Turns what is read from the bridge's output, in chunks of any size, into its messages. */
export class BridgeFrameDecoder {
  private pending: Bytes = new Uint8Array(0);

  /** The messages completed by `chunk`. Throws when the bytes are not frames: nothing after that can be trusted. */
  push(chunk: Uint8Array): BridgeIncoming[] {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    const messages: BridgeIncoming[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(joined.buffer, at, 4).getUint32(0);
      if (length < 1 || length > BRIDGE_MAX_FRAME_BYTES) {
        throw new Error(`the bridge sent a frame of ${String(length)} bytes: this is not its protocol`);
      }
      if (joined.length - at - 4 < length) break;
      const kind = joined[at + 4];
      const body = joined.subarray(at + 5, at + 4 + length);
      at += 4 + length;
      if (kind === KIND_BINARY) {
        if (body.length < 4) throw new Error("the bridge sent binary data of no channel");
        const channel = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
        messages.push({ event: "binary", channel, data: body.slice(4) });
      } else if (kind === KIND_JSON) {
        const parsed: unknown = JSON.parse(utf8Decode(body));
        if (isIncoming(parsed)) messages.push(parsed);
      } else {
        throw new Error(`the bridge sent a frame of kind ${String(kind)}: this is not its protocol`);
      }
    }
    this.pending = joined.slice(at);
    return messages;
  }
}

// ---------------------------------------------------------------- ports and the hub

/** One view's own use of a bridge: its requests and channels, numbered as it likes. */
export interface BridgePort {
  send(message: BridgeOutgoing): void;
  /** Hears what the bridge sends this port; the function it returns stops that. */
  subscribe(listener: (message: BridgeIncoming) => void): () => void;
  /** Ends the port: its requests are cancelled, its channels closed. */
  close(): void;
}

/**
 * One bridge shared by several ports. Each port has its own ids and channel numbers, which the hub translates
 * to the bridge's and back, so two views cannot take each other's answers; a port that closes takes what it
 * had open with it.
 */
export class BridgeHub {
  private nextId = 1;
  private nextChannel = 1;
  private readonly requests = new Map<number, { port: HubPort; id: BridgeId }>();
  private readonly channels = new Map<number, { port: HubPort; channel: number }>();
  private readonly ports = new Set<HubPort>();
  private readyMessage: Extract<BridgeIncoming, { event: "ready" }> | null = null;
  private closed: string | null = null;

  /** `write` sends one message to the bridge (`encodeBridgeFrame`, then its input). */
  constructor(private readonly write: (message: BridgeOutgoing) => void) {}

  /** What the bridge said when it started, once it has. */
  get ready(): Extract<BridgeIncoming, { event: "ready" }> | null {
    return this.readyMessage;
  }

  /** A message of the bridge (from a `BridgeFrameDecoder`). */
  receive(message: BridgeIncoming): void {
    if (message.event === "ready") {
      this.readyMessage = message;
      for (const port of this.ports) port.deliver(message);
    } else if (message.event === "error") {
      for (const port of this.ports) port.deliver(message);
    } else if (message.event === "response") {
      if (typeof message.id !== "number") return;
      const entry = this.requests.get(message.id);
      if (!entry) return;
      this.requests.delete(message.id);
      entry.port.deliver({ ...message, id: entry.id });
    } else {
      const entry = this.channels.get(message.channel);
      if (!entry) return;
      if (message.event === "close" || message.event === "refused") {
        this.channels.delete(message.channel);
        entry.port.channels.delete(entry.channel);
      }
      entry.port.deliver({ ...message, channel: entry.channel });
    }
  }

  /** The bridge is gone (its process ended): everything in flight is answered, and nothing more is sent. */
  end(reason = "the bridge ended"): void {
    if (this.closed !== null) return;
    this.closed = reason;
    for (const [, { port, id }] of this.requests) {
      port.deliver({ event: "response", id, status: 503, json: { error: { code: "bridge_closed", message: reason } } });
    }
    for (const [, { port, channel }] of this.channels) port.deliver({ event: "close", channel, code: 1006, reason });
    this.requests.clear();
    this.channels.clear();
  }

  /** A new port. */
  port(): BridgePort {
    const port = new HubPort(this);
    this.ports.add(port);
    if (this.readyMessage) port.deliver(this.readyMessage);
    return port;
  }

  /** @internal */
  forward(port: HubPort, message: BridgeOutgoing): void {
    if (this.closed !== null) {
      if (message.op === "request") {
        const json = { error: { code: "bridge_closed", message: this.closed } };
        port.deliver({ event: "response", id: message.id, status: 503, json });
      } else if (message.op === "open") {
        port.deliver({ event: "close", channel: message.channel, code: 1006, reason: this.closed });
      }
      return;
    }
    if (message.op === "request") {
      const id = this.nextId++;
      this.requests.set(id, { port, id: message.id });
      port.requests.set(message.id, id);
      this.write({ ...message, id });
    } else if (message.op === "cancel") {
      const id = port.requests.get(message.id);
      if (id !== undefined) this.write({ op: "cancel", id });
    } else if (message.op === "open") {
      const channel = this.nextChannel++;
      this.channels.set(channel, { port, channel: message.channel });
      port.channels.set(message.channel, channel);
      this.write({ ...message, channel });
    } else {
      const channel = port.channels.get(message.channel);
      if (channel !== undefined) this.write({ ...message, channel });
    }
  }

  /** @internal */
  release(port: HubPort): void {
    this.ports.delete(port);
    for (const [id, entry] of this.requests) {
      if (entry.port !== port) continue;
      this.requests.delete(id);
      if (this.closed === null) this.write({ op: "cancel", id });
    }
    for (const [channel, entry] of this.channels) {
      if (entry.port !== port) continue;
      this.channels.delete(channel);
      if (this.closed === null) this.write({ op: "close", channel });
    }
  }
}

class HubPort implements BridgePort {
  /** The port's own ids and channels, and the bridge's for each. */
  readonly requests = new Map<BridgeId, number>();
  readonly channels = new Map<number, number>();
  private readonly listeners = new Set<(message: BridgeIncoming) => void>();
  private open = true;

  constructor(private readonly hub: BridgeHub) {}

  send(message: BridgeOutgoing): void {
    if (this.open) this.hub.forward(this, message);
  }

  subscribe(listener: (message: BridgeIncoming) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  deliver(message: BridgeIncoming): void {
    if (message.event === "response") this.requests.delete(message.id);
    for (const listener of [...this.listeners]) listener(message);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.hub.release(this);
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------- fetch and WebSocket over a port

/** The address the API client is given for a bridge: its paths are all that travels. */
export const BRIDGE_BASE_URL = "http://bridge.invalid";

function pathOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(url);
  return match ? (match[1] ?? "/") : url;
}

function bodyBytes(body: BridgeBody): Bytes {
  if (body.json !== undefined) return utf8Encode(JSON.stringify(body.json));
  if (body.text !== undefined) return utf8Encode(body.text);
  if (body.base64 !== undefined) return base64Decode(body.base64);
  return new Uint8Array(0);
}

/** An answer of the bridge as the parts of a `Response` a caller reads. */
class BridgeResponse implements HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText = "";
  readonly headers: { get(name: string): string | null };

  constructor(private readonly answer: Extract<BridgeIncoming, { event: "response" }>) {
    this.status = answer.status;
    this.ok = answer.status >= 200 && answer.status < 300;
    const headers = new Map(Object.entries(answer.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    this.headers = { get: (name) => headers.get(name.toLowerCase()) ?? null };
  }

  json(): Promise<unknown> {
    if (this.answer.json !== undefined) return Promise.resolve(this.answer.json);
    try {
      const parsed: unknown = JSON.parse(utf8Decode(bodyBytes(this.answer)));
      return Promise.resolve(parsed);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  text(): Promise<string> {
    return Promise.resolve(utf8Decode(bodyBytes(this.answer)));
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(bodyBytes(this.answer).buffer);
  }

  clone(): BridgeResponse {
    return new BridgeResponse(this.answer);
  }
}

/** The platform's own `Response`, where it has one (a browser, a webview, Node): its constructor, as far as used. */
type ResponseConstructor = new (
  body: Uint8Array<ArrayBuffer> | null,
  init: { status: number; headers: Record<string, string> },
) => HttpResponseLike;

function isResponseConstructor(value: unknown): value is ResponseConstructor {
  return typeof value === "function";
}

/** Statuses that have no body: a `Response` refuses one. */
const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * An answer of the bridge as a caller of `fetch` expects it: the platform's own `Response` where there is one
 * (code written for a browser asks whether it has been given one), this module's otherwise.
 */
function responseOf(answer: Extract<BridgeIncoming, { event: "response" }>): HttpResponseLike {
  const Platform: unknown = Reflect.get(globalThis, "Response");
  if (!isResponseConstructor(Platform) || answer.status < 200 || answer.status > 599) return new BridgeResponse(answer);
  const headers = { ...answer.headers };
  // JSON travels as JSON: it is text again here, and says so
  if (answer.json !== undefined && headers["content-type"] === undefined) headers["content-type"] = "application/json";
  const bytes = bodyBytes(answer);
  return new Platform(NO_BODY.has(answer.status) || bytes.length === 0 ? null : bytes, {
    status: answer.status,
    headers,
  });
}

interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
}

function isAbortLike(value: unknown): value is AbortLike {
  return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value;
}

function abortError(): Error {
  const error = new Error("The request was cancelled.");
  error.name = "AbortError";
  return error;
}

function requestBody(init: RequestInitLike | undefined): BridgeBody {
  const body = init?.body;
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { text: body };
  if (body instanceof Uint8Array) return { base64: base64Encode(body) };
  if (body instanceof ArrayBuffer) return { base64: base64Encode(new Uint8Array(body)) };
  throw new Error("a request over the bridge has a string or bytes for a body");
}

function requestHeaders(init: RequestInitLike | undefined): Record<string, string> {
  const headers = init?.headers;
  if (typeof headers !== "object" || headers === null) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (typeof value === "string") out[name] = value;
  return out;
}

const WS_CLOSING = 2;
const WS_CLOSED = 3;

/** What `createApiClient` needs to run on a bridge: spread it into the client's options. */
export interface BridgeTransport {
  fetch: FetchLike;
  WebSocket: WebSocketConstructor;
  baseUrl: string;
}

/**
 * A `fetch` and a `WebSocket` whose exchanges go through `port`:
 *
 *     const api = createApiClient(bridgeTransport(port));
 *
 * A channel the bridge refuses (no such driver, a stub) is told as the API's own WebSocket tells an error after
 * the upgrade: an error frame, then the close.
 */
export function bridgeTransport(port: BridgePort): BridgeTransport {
  let nextId = 1;
  let nextChannel = 1;
  const waiting = new Map<BridgeId, (answer: Extract<BridgeIncoming, { event: "response" }>) => void>();
  const sockets = new Map<number, BridgeSocket>();

  port.subscribe((message) => {
    if (message.event === "response") {
      const settle = waiting.get(message.id);
      waiting.delete(message.id);
      settle?.(message);
    } else if ("channel" in message) {
      sockets.get(message.channel)?.receive(message);
    }
  });

  const fetchOverBridge: FetchLike = (url, init) =>
    new Promise((resolve, reject) => {
      const signal = isAbortLike(init?.signal) ? init.signal : undefined;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const id = nextId++;
      let message: BridgeOutgoing;
      try {
        message = {
          op: "request",
          id,
          method: (init?.method ?? "GET").toUpperCase(),
          path: pathOf(url),
          headers: requestHeaders(init),
          ...requestBody(init),
        };
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      waiting.set(id, (answer) => {
        resolve(responseOf(answer));
      });
      signal?.addEventListener("abort", () => {
        if (!waiting.delete(id)) return;
        port.send({ op: "cancel", id });
        reject(abortError());
      });
      port.send(message);
    });

  class BridgeSocket implements WebSocketLike {
    readyState = 0;
    readonly bufferedAmount = 0;
    binaryType = "arraybuffer";
    private readonly channel = nextChannel++;
    private readonly listeners = new Map<string, ((event: WebSocketEventLike) => void)[]>();

    constructor(url: string) {
      sockets.set(this.channel, this);
      port.send({ op: "open", channel: this.channel, path: pathOf(url) });
    }

    addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    private emit(type: string, event: Omit<WebSocketEventLike, "type"> = {}): void {
      for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event });
    }

    send(data: string | Bytes): void {
      if (this.readyState !== 1) return;
      if (typeof data === "string") port.send({ op: "text", channel: this.channel, data });
      else port.send({ op: "binary", channel: this.channel, data });
    }

    close(code?: number): void {
      if (this.readyState >= WS_CLOSING) return;
      this.readyState = WS_CLOSING;
      port.send(
        code === undefined ? { op: "close", channel: this.channel } : { op: "close", channel: this.channel, code },
      );
    }

    receive(message: BridgeIncoming): void {
      if (message.event === "open") {
        if (this.readyState === 0) this.readyState = 1;
        this.emit("open");
      } else if (message.event === "text") {
        this.emit("message", { data: message.data });
      } else if (message.event === "binary") {
        // the bytes alone, as an ArrayBuffer: what a WebSocket with `binaryType = "arraybuffer"` gives
        const { data } = message;
        const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
        this.emit("message", { data: whole ? data.buffer : data.slice().buffer });
      } else if (message.event === "refused") {
        const error =
          typeof message.json === "object" && message.json !== null && "error" in message.json
            ? message.json.error
            : { code: "refused", message: "The channel was refused." };
        this.emit("message", { data: JSON.stringify({ type: "error", error }) });
        this.finish(1008);
      } else if (message.event === "close") {
        this.finish(message.code ?? 1005);
      }
    }

    private finish(code: number): void {
      if (this.readyState === WS_CLOSED) return;
      this.readyState = WS_CLOSED;
      sockets.delete(this.channel);
      this.emit("close", { code });
    }
  }

  return { fetch: fetchOverBridge, WebSocket: BridgeSocket, baseUrl: BRIDGE_BASE_URL };
}

/**
 * The ends of a pipe of messages as a port: what a view in a frame or a webview has (`post` is its
 * `postMessage`, `listen` its `message` events), with the hub's port at the other end.
 */
export function messagePort(
  post: (message: BridgeOutgoing) => void,
  listen: (listener: (message: BridgeIncoming) => void) => () => void,
): BridgePort {
  let open = true;
  const stops: (() => void)[] = [];
  return {
    send: (message) => {
      if (open) post(message);
    },
    subscribe: (listener) => {
      const stop = listen(listener);
      stops.push(stop);
      return stop;
    },
    close: () => {
      open = false;
      for (const stop of stops.splice(0)) stop();
    },
  };
}

// ---------------------------------------------------------------- a page on a bridge

/** The name of the global a host sets before it loads the page (see `PageHost`). */
export const PAGE_HOST_GLOBAL = "__JUMPSTARTER_HOST__";

/**
 * What a host that shows a page of Jumpstarter Web in a window of its own gives that page, as the global
 * `__JUMPSTARTER_HOST__`, set before the page's script runs: the page then has no server. Its API is the bridge
 * at the other end of `post` and `listen`, and its files are where `url` says.
 */
export interface PageHost {
  /** Sends a message to the bridge (through the hub's port for this page). */
  post(message: BridgeOutgoing): void;
  /** Hears the bridge's messages for this page; the function it returns stops that. */
  listen(listener: (message: BridgeIncoming) => void): () => void;
  /** What the API's paths are under, for a page of one role of a lease with members: `/api/v1/roles/phone`. */
  basePath?: string;
  /** Where a file the server would serve (`/plugins/hmi/entry.js`) is for this page. */
  url?(path: string): string;
  /**
   * The address of an empty page of this page's own origin, for a frame the page fills itself (a plugin's page
   * that the plugin has to reach into: the Appium Inspector). A host gives one where a frame with no address
   * (`srcdoc`) cannot load the plugin's files: an editor's webview serves them only to pages it knows.
   */
  emptyPage?: string;
  /**
   * The page is one view, alone in a window of the host (an editor's tab), with no tool window of the page's
   * beside it: a view keeps inside itself what it would otherwise put in one (the Appium Inspector's tabs).
   */
  standalone?: boolean;
  /** Follows the host's theme (`{ mode, tokens }`, as `jumpstarter.host/1` carries it); returns what stops it. */
  theme?(listener: (theme: unknown) => void): () => void;
}

function isPageHost(value: unknown): value is PageHost {
  return (
    typeof value === "object" &&
    value !== null &&
    "post" in value &&
    typeof value.post === "function" &&
    "listen" in value &&
    typeof value.listen === "function"
  );
}

/** The page's host, when a host shows it (`null` for a page that a server serves). */
export function pageHost(): PageHost | null {
  const value: unknown = Reflect.get(globalThis, PAGE_HOST_GLOBAL);
  return isPageHost(value) ? value : null;
}

/** A URL of the server's (`/plugins/...`, `/assets/...`) as this page loads it: the host's, when it has one. */
export function hostUrl(path: string): string {
  const host = pageHost();
  return host?.url && path.startsWith("/") && !path.startsWith("//") ? host.url(path) : path;
}

let hostClientTransport: BridgeTransport | null = null;

/**
 * The transport of a page that a host shows, or `null`: one port for the page, whatever clients it makes. A
 * client of the page spreads it into its options and adds the host's `basePath` and its own to `baseUrl`.
 */
export function pageHostTransport(): BridgeTransport | null {
  const host = pageHost();
  if (host === null) return null;
  hostClientTransport ??= bridgeTransport(
    messagePort(
      (message) => {
        host.post(message);
      },
      (listener) => host.listen(listener),
    ),
  );
  return { ...hostClientTransport, baseUrl: `${BRIDGE_BASE_URL}${host.basePath ?? ""}` };
}
