// connection.mjs — discovery + authenticated WebSocket client for the
// StykAnimate "agent bridge" (Settings → Assistant connection in the app).
//
// Discovery: one JSON file per app instance in ~/.styk-animate/bridge/ named
// instance-<pid>.json with {bridge:'styk-agent', schema:1, port, token, pid, ...}.
// Stale records (dead pid) are swept; live ones are kept.
//
// Protocol (ws://127.0.0.1:<port>/bridge, JSON text frames):
//   1. client sends {op:'hello', token, schema:1} within 5s of connecting
//   2. server replies {ok:true, bridge:'styk-agent', schema:1, pid, version}
//   3. requests carry an integer `seq`; replies echo it. Reply has ok:true|false;
//      on false: error (+ reason / status).
// Close codes: 4401 wrong token, 4409 wrong schema, 4403 lockout, 4400
// malformed/silent, 1000/1001 = bridge turned off cleanly.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

export const SCHEMA = 1;
export const RECORD_PATTERN = /^instance-(\d+)\.json$/;
/** Fallback location; `STYK_BRIDGE_DIR` overrides it (see defaultBridgeDir()). */
export const DEFAULT_BRIDGE_DIR = path.join(os.homedir(), '.styk-animate', 'bridge');

/** Effective discovery directory: `STYK_BRIDGE_DIR` env override, else the home default. */
export function defaultBridgeDir() {
  return process.env.STYK_BRIDGE_DIR || DEFAULT_BRIDGE_DIR;
}

const CONNECT_TIMEOUT_MS = 5_000; // hello must go out within 5s of connecting
const HANDSHAKE_TIMEOUT_MS = 5_000; // waiting for the hello reply
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** Error type carrying a machine-readable `code` and optional user-facing `hint`. */
export class BridgeError extends Error {
  constructor(message, { code = 'bridge-error', hint } = {}) {
    super(hint ? `${message} — ${hint}` : message);
    this.name = 'BridgeError';
    this.code = code;
    this.hint = hint;
  }
}

function resolveDir(dir) {
  return dir ?? defaultBridgeDir();
}

/** `STYK_BRIDGE_PID` pins a specific app instance (env fallback). */
export function envPinnedPid() {
  const v = Number(process.env.STYK_BRIDGE_PID);
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** true when the OS reports the pid as alive (EPERM ⇒ exists, busy signal). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Discover live bridge records in `dir`, sweeping stale files (dead pid ⇒
 * delete the record; anything else is left untouched). Never throws for
 * missing/unreadable dirs — surfaces problems as `warnings`.
 */
export async function discoverInstances(dir) {
  const result = { dir: resolveDir(dir), instances: [], removed: [], warnings: [] };
  if (!dir) dir = result.dir;

  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return result; // bridge never used yet → "off"
    result.warnings.push(`cannot read ${dir}: ${err.message}`);
    return result;
  }

  for (const name of names) {
    if (!RECORD_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    let rec;
    try {
      rec = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
      result.warnings.push(`skipping unparseable ${name}: ${err.message}`);
      continue; // corrupt record — be conservative, do not delete
    }
    if (
      !rec || typeof rec !== 'object' ||
      rec.bridge !== 'styk-agent' || rec.schema !== SCHEMA ||
      !Number.isInteger(rec.pid) || rec.pid <= 0 ||
      !Number.isInteger(rec.port) || rec.port <= 0 ||
      typeof rec.token !== 'string' || rec.token.length === 0
    ) {
      result.warnings.push(`skipping unrecognized record ${name}`);
      continue;
    }
    if (!pidAlive(rec.pid)) {
      try {
        await fsp.unlink(file);
        result.removed.push(name);
      } catch (err) {
        result.warnings.push(`could not remove stale ${name}: ${err.message}`);
      }
      continue;
    }
    result.instances.push({
      pid: rec.pid,
      port: rec.port,
      token: rec.token,
      version: rec.version ?? 'unknown',
      project: rec.project ?? null,
      name: rec.name ?? 'StykAnimate',
      started: Number.isInteger(rec.started) ? rec.started : 0,
      file,
    });
  }

  // Default selection: most recently started instance.
  result.instances.sort((a, b) => b.started - a.started || a.pid - b.pid);
  return result;
}

export class BridgeConnection {
  #dir;
  #pinnedPid;
  #requestTimeoutMs;
  #ws = null;
  #info = null;
  #connecting = null;
  #pending = new Map(); // seq → { resolve, reject, timer }
  #seq = 0;
  #handshakeResolve = null;
  #handshakeReject = null;
  #lastClose = null;
  #lastError = null;
  #lastEvent = null;

  constructor({
    dir,
    pid = null,               // explicit pin (tests); falls back to env
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    this.#dir = resolveDir(dir);
    this.#pinnedPid = pid ?? envPinnedPid();
    this.#requestTimeoutMs = Math.max(1, requestTimeoutMs);
  }

  /**
   * Discovery + connection state. Never talks to the app — safe to call when
   * StykAnimate is not running (returns `running:false`).
   */
  async status() {
    const disc = await discoverInstances(this.#dir);
    const pin = this.#pinnedPid;
    let selected = null;
    if (disc.instances.length > 0) {
      if (pin) {
        selected = disc.instances.find((i) => i.pid === pin) ?? null;
      } else {
        selected = disc.instances[0];
      }
    }
    const connected = Boolean(
      this.#ws && this.#ws.readyState === WebSocket.OPEN && this.#info,
    );
    return {
      dir: disc.dir,
      running: disc.instances.length > 0,
      instances: disc.instances,
      removedStale: disc.removed,
      warnings: disc.warnings,
      pinnedPid: pin ?? null,
      selected,
      pinnedMissing: Boolean(pin && disc.instances.length > 0 && !selected),
      connected,
      connection: connected ? this.#info : null,
      lastClose: this.#lastClose,
      lastError: this.#lastError,
      lastEvent: this.#lastEvent,
    };
  }

  /**
   * Send a request over the shared socket and resolve with the full reply
   * object (including ok:false replies — callers map those). Auto-connects
   * lazily and auto-reconnects on the next call after any drop.
   */
  async request(op, payload = {}) {
    const ws = await this.#ensure();
    const seq = ++this.#seq;
    let frame;
    try {
      frame = JSON.stringify({ op, seq, ...payload });
    } catch (err) {
      throw new BridgeError(`Cannot encode request '${op}': ${err.message}`, { code: 'encode' });
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.#pending.delete(seq);
        reject(new BridgeError(
          `Bridge did not answer '${op}' within ${this.#requestTimeoutMs}ms`,
          { code: 'timeout' },
        ));
      }, this.#requestTimeoutMs);
      entry.timer.unref?.();
      this.#pending.set(seq, entry);
      try {
        ws.send(frame);
      } catch {
        this.#pending.delete(seq);
        clearTimeout(entry.timer);
        this.#dropSocket('the connection dropped before the request was sent');
        reject(new BridgeError(`Connection dropped sending '${op}'`, { code: 'closed' }));
      }
    });
  }

  /** Close the socket and reject everything pending. Safe to call twice. */
  close() {
    this.#dropSocket('client closed the connection');
  }

  // — internals ————————————————————————————————————————————————

  async #ensure() {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN && this.#info) {
      return this.#ws;
    }
    if (this.#connecting) return this.#connecting;
    // Not open (first use, or a drop since the last call) — reconnect fresh.
    this.#connecting = this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect() {
    const inst = await this.#pickInstance();
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/bridge`);
    this.#ws = ws;

    let handshakeDone = false;
    const handshake = new Promise((resolve, reject) => {
      this.#handshakeResolve = resolve;
      this.#handshakeReject = reject;
    });

    const timer = setTimeout(() => {
      if (!handshakeDone) this.#handshakeReject?.(new BridgeError(
        `Timed out connecting to the StykAnimate bridge (pid ${inst.pid}, port ${inst.port})`,
        { code: 'connect-failed' },
      ));
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();

    ws.on('open', () => {
      // Protocol: hello must arrive within 5s of connecting.
      try {
        ws.send(JSON.stringify({ op: 'hello', token: inst.token, schema: SCHEMA }));
      } catch (err) {
        this.#handshakeReject?.(new BridgeError(`Failed to send hello: ${err.message}`, { code: 'connect-failed' }));
      }
    });

    ws.on('message', (data) => {
      if (!handshakeDone) {
        handshakeDone = true;
        clearTimeout(timer);
        this.#handshakeResolve?.(data);
        return;
      }
      this.#onData(data);
    });

    ws.on('error', (err) => {
      if (!handshakeDone) {
        this.#handshakeReject?.(new BridgeError(
          `Could not connect to the StykAnimate bridge (pid ${inst.pid}, port ${inst.port}): ${err.message}`,
          { code: 'connect-failed' },
        ));
      }
      // Post-handshake errors are followed by a 'close'; nothing to do here.
    });

    ws.on('close', (code, reason) => this.#onClose(code, reason));

    const opened = await handshake.catch((err) => {
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* ignore */ }
      if (this.#ws === ws) { this.#ws = null; this.#info = null; }
      throw err;
    });

    let reply;
    try {
      reply = JSON.parse(String(opened));
    } catch {
      throw new BridgeError('Bridge sent a non-JSON hello reply', { code: 'protocol' });
    }
    if (reply.ok !== true || reply.bridge !== 'styk-agent' || reply.schema !== SCHEMA) {
      throw new BridgeError('Bridge rejected the hello handshake', { code: 'handshake' });
    }

    this.#info = {
      pid: inst.pid,
      version: reply.version ?? inst.version ?? 'unknown',
      name: inst.name,
      project: inst.project,
      connectedAt: Date.now(),
    };
    return ws;
  }

  async #pickInstance() {
    const { instances } = await discoverInstances(this.#dir);
    if (instances.length === 0) {
      throw new BridgeError(
        'StykAnimate agent bridge not found — no app has the Assistant connection turned on',
        { code: 'not-available', hint: 'Open StykAnimate and turn on Settings → Assistant connection.' },
      );
    }
    if (this.#pinnedPid) {
      const inst = instances.find((i) => i.pid === this.#pinnedPid);
      if (!inst) {
        throw new BridgeError(
          `Pinned bridge instance pid ${this.#pinnedPid} is not alive` +
          ` (live: ${instances.map((i) => i.pid).join(', ') || 'none'})`,
          { code: 'not-available' },
        );
      }
      return inst;
    }
    return instances[0]; // latest `started`
  }

  #onData(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // ignore undecodable traffic; never propagate to the caller
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.op === 'event') {
      this.#lastEvent = { at: Date.now(), ...msg };
      return; // unsolicited change pushes — no caller is waiting
    }
    const entry = this.#pending.get(msg.seq);
    if (!entry) return;
    this.#pending.delete(msg.seq);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }

  #onClose(code, reason) {
    const raw = reason && reason.length > 0 ? reason.toString('utf8') : '';
    this.#lastClose = { code, reason: raw, at: Date.now() };
    this.#dropSocket(this.closeError(code));
  }

  /** Map a WebSocket close code onto the protocol meaning (a BridgeError). */
  closeError(code) {
    switch (code) {
      case 1000:
      case 1001:
        return new BridgeError('The StykAnimate agent bridge turned off', { code: 'closed' });
      case 4400:
        return new BridgeError('Bridge closed with 4400 (malformed/silent handshake)', { code: 'handshake' });
      case 4401:
        return new BridgeError('Bridge rejected the token (close 4401) — the app is running a different one', {
          code: 'auth-failed',
          hint: 'turn Settings → Assistant connection off and on again, or restart the app',
        });
      case 4403:
        return new BridgeError('Bridge closed with 4403 (locked out after repeated auth failures)', {
          code: 'locked-out',
          hint: 'wait a moment or restart the app',
        });
      case 4409:
        return new BridgeError('Bridge closed with 4409 (schema mismatch between the app and this MCP server)', { code: 'schema' });
      default:
        return new BridgeError(`Bridge connection closed (code ${code})`, { code: 'closed' });
    }
  }

  /** Reject all pending requests with `failure`, then discard the socket. */
  #dropSocket(failure) {
    const err = failure instanceof Error
      ? failure
      : new BridgeError(String(failure), { code: 'closed' });
    this.#lastError = err;
    if (this.#handshakeReject) {
      const rej = this.#handshakeReject;
      this.#handshakeReject = null;
      this.#handshakeResolve = null;
      rej(new BridgeError(`Connection dropped during handshake: ${err.message}`, { code: err.code }));
    }
    for (const [seq, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.#pending.delete(seq);
    }
    const ws = this.#ws;
    this.#ws = null;
    this.#info = null;
    if (ws) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }
}
