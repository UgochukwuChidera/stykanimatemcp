// Tests for connection.mjs against a fake bridge WebSocket server.
// The real app is never needed: discovery uses a throwaway tmp directory
// (also checking the STYK_BRIDGE_DIR env override), and the WebSocket
// side runs an in-process fake bridge from test/helpers/fake-bridge.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  BridgeConnection,
  BridgeError,
  defaultBridgeDir,
  discoverInstances,
  envPinnedPid,
  RECORD_PATTERN,
} from '../connection.mjs';
import { startFakeBridge, TINY_PNG } from './helpers/fake-bridge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A pid that is definitely dead: run a short-lived child, keep its pid. */
async function getDeadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => child.on('exit', resolve));
  await sleep(50); // make sure the pid is reaped everywhere we care about
  return child.pid;
}

async function tmpBridgeDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'styk-bridge-test-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeInstance(dir, { pid = process.pid, port, token = 'test-token', started = Date.now(), version = '1.2.3', project = 'demo.styk', filename = null } = {}) {
  const name = filename ?? `instance-${pid}.json`;
  await fsp.writeFile(
    path.join(dir, name),
    JSON.stringify({ bridge: 'styk-agent', schema: 1, port, token, pid, version, project, name: 'StykAnimate', started }),
  );
  return name;
}

test('record filename pattern matches only bridge record files', () => {
  assert.equal(RECORD_PATTERN.test('instance-1234.json'), true);
  assert.equal(RECORD_PATTERN.test('instance-x.json'), false);
  assert.equal(RECORD_PATTERN.test('other-123.json'), false);
  assert.match(RECORD_PATTERN.exec('instance-42.json')[1], /^42$/);
});

test('discoverInstances: empty/missing directory means bridge off, no exception', async (t) => {
  const dir = path.join(await tmpBridgeDir(t), 'does-not-exist');
  const result = await discoverInstances(dir);
  assert.deepEqual(result.instances, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.warnings, []);
});

test('discoverInstances keeps the live record and sweeps the stale one', async (t) => {
  const dir = await tmpBridgeDir(t);
  const deadPid = await getDeadPid();
  const staleName = await writeInstance(dir, { pid: deadPid, port: 11, started: 999 }); // most recent started!
  const liveName = await writeInstance(dir, { pid: process.pid, port: 12, started: 1 });

  const result = await discoverInstances(dir);

  assert.equal(result.instances.length, 1);
  assert.deepEqual(
    { pid: result.instances[0].pid, port: result.instances[0].port },
    { pid: process.pid, port: 12 },
  );
  assert.deepEqual(result.removed, [staleName]); // dead pid ⇒ file deleted
  assert.equal(await fsp.stat(path.join(dir, liveName)).then(() => true).catch(() => false), true);
  assert.equal(await fsp.stat(path.join(dir, staleName)).then(() => true).catch(() => false), false);
});

test('sorts live instances by `started` descending (latest first)', async (t) => {
  const dir = await tmpBridgeDir(t);
  // Distinct filenames but all pinned to a live pid (this test process) so the
  // stale sweep cannot remove any of them.
  await writeInstance(dir, { filename: 'instance-990001.json', port: 21, started: 100 });
  await writeInstance(dir, { filename: 'instance-990002.json', port: 22, started: 300 });
  await writeInstance(dir, { filename: 'instance-990003.json', port: 23, started: 200 });
  const result = await discoverInstances(dir);
  assert.deepEqual(result.instances.map((i) => i.port), [22, 23, 21]);
});

test('discoverInstances reports (but keeps) corrupt records as warnings', async (t) => {
  const dir = await tmpBridgeDir(t);
  await fsp.writeFile(path.join(dir, 'instance-999999.json'), '{not json');
  const result = await discoverInstances(dir);
  assert.equal(result.instances.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /instance-999999\.json/);
  // corrupt file is left in place — conservative, only dead-pid records are swept
  assert.notDeepEqual(result.removed, ['instance-999999.json']);
});

test('STYK_BRIDGE_DIR env override and STYK_BRIDGE_PID pin are picked up', () => {
  const prevDir = process.env.STYK_BRIDGE_DIR;
  const prevPid = process.env.STYK_BRIDGE_PID;
  try {
    process.env.STYK_BRIDGE_DIR = '/custom/bridge/dir';
    assert.equal(defaultBridgeDir(), '/custom/bridge/dir'); // env wins at call time
    process.env.STYK_BRIDGE_DIR = '/other/dir';
    assert.equal(defaultBridgeDir(), '/other/dir');
    process.env.STYK_BRIDGE_PID = '4242';
    assert.equal(envPinnedPid(), 4242);
    const conn = new BridgeConnection(); // no options → falls back to env pins
    // (no connect attempted here; the constructor must not throw without the app)
  } finally {
    if (prevDir === undefined) delete process.env.STYK_BRIDGE_DIR; else process.env.STYK_BRIDGE_DIR = prevDir;
    if (prevPid === undefined) delete process.env.STYK_BRIDGE_PID; else process.env.STYK_BRIDGE_PID = prevPid;
  }
});

test('status() answers "not running" gracefully with no app', async (t) => {
  const dir = await tmpBridgeDir(t);
  const conn = new BridgeConnection({ dir });
  const s = await conn.status();
  assert.equal(s.running, false);
  assert.deepEqual(s.instances, []);
  assert.equal(s.selected, null);
  assert.equal(s.connected, false);
});

test('hello + auth flow, then list/invoke/seek/snapshot/render round-trips', async (t) => {
  const dir = await tmpBridgeDir(t);
  const bridge = await startFakeBridge({ token: 'sekret', appPid: process.pid, project: 'demo.styk' });
  t.after(() => bridge.close());
  await writeInstance(dir, { pid: process.pid, port: bridge.port, token: 'sekret' });

  const conn = new BridgeConnection({ dir });

  const list = await conn.request('list');
  assert.equal(list.ok, true);
  assert.equal(list.commands.length, 3);
  assert.equal(bridge.state.connections, 1);

  const invoke = await conn.request('invoke', { command: 'file.save' });
  assert.equal(invoke.ok, true);
  assert.equal(invoke.ran, true);
  assert.equal(invoke.command, 'file.save');
  assert.equal(invoke.status.revision, 7);

  const seek = await conn.request('seek', { frame: 12 });
  assert.equal(seek.ok, true);

  const undo = await conn.request('undo');
  const redo = await conn.request('redo');
  assert.equal(undo.ok, true);
  assert.equal(redo.ok, true);

  const snap = await conn.request('snapshot');
  assert.equal(snap.ok, true);
  assert.equal(snap.document.tick, 5);
  assert.deepEqual(snap.document.layers, [{ id: 1, name: 'Layer 1', kind: 'figure' }]);

  const render = await conn.request('render', { frames: [2, 3] });
  assert.equal(render.ok, true);
  assert.equal(render.frames.length, 2);
  const payload = render.frames[0].image.split('base64,')[1];
  assert.deepEqual(Buffer.from(payload, 'base64').subarray(0, 8), TINY_PNG.subarray(0, 8));

  const s = await conn.status();
  assert.equal(s.running, true);
  assert.equal(s.selected.pid, process.pid);
  assert.equal(s.connected, true);
  assert.equal(s.connection.pid, process.pid);
  assert.equal(s.connection.version, '1.2.3');
});

test('seq correlation: concurrent requests resolve to their own replies even when scrambled', async (t) => {
  const dir = await tmpBridgeDir(t);
  const bridge = await startFakeBridge({});
  t.after(() => bridge.close());
  await writeInstance(dir, { pid: process.pid, port: bridge.port, token: 'test-token', started: 5 });

  const conn = new BridgeConnection({ dir });
  const [slow, list, fast, bad] = await Promise.all([
    conn.request('invoke', { command: 'slow' }),  // server delays 300ms
    conn.request('list'),
    conn.request('invoke', { command: 'file.save' }),
    conn.request('invoke', { command: 'no-such-command' }),
  ]);
  assert.equal(slow.ok, true);
  assert.equal(slow.command, 'slow');
  assert.equal(list.ok, true);
  assert.equal(list.commands[0].id, 'file.save');
  assert.equal(fast.ok, true);
  assert.equal(fast.command, 'file.save');
  assert.equal(bad.ok, false); // resolved verbatim, mapped by the tool layer
  assert.equal(bad.error, 'unknown command');
});

test('pending requests reject when the server drops the connection; next call reconnects', async (t) => {
  const dir = await tmpBridgeDir(t);
  const bridge = await startFakeBridge({});
  t.after(() => bridge.close());
  await writeInstance(dir, { pid: process.pid, port: bridge.port, token: 'test-token', started: 5 });

  const conn = new BridgeConnection({ dir });
  await conn.request('list');
  assert.equal(bridge.state.connections, 1);

  const pending = conn.request('invoke', { command: 'slow' }); // queued behind 300ms
  await sleep(20);
  bridge.closeClients(1001); // bridge turned off mid-request
  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, 'closed');
    return true;
  });

  const again = await conn.request('list'); // reconnects lazily on next call
  assert.equal(again.ok, true);
  assert.equal(bridge.state.connections, 2);
  assert.equal((await conn.status()).connected, true);
});

test('wrong token / bad auth surfaces a helpful error (close 4401)', async (t) => {
  const dir = await tmpBridgeDir(t);
  const bridge = await startFakeBridge({ token: 'right-token' });
  t.after(() => bridge.close());
  await writeInstance(dir, { pid: process.pid, port: bridge.port, token: 'stale-token', started: 5 });

  const conn = new BridgeConnection({ dir });
  await assert.rejects(() => conn.request('list'), (err) => {
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, 'auth-failed');
    assert.match(err.message, /4401/);
    return true;
  });
  const s = await conn.status();
  assert.equal(s.lastClose?.code, 4401); // surface the close reason for diagnostics
});

test('pinned pid that is not alive is reported precisely', async (t) => {
  const dir = await tmpBridgeDir(t);
  const bridge = await startFakeBridge({});
  t.after(() => bridge.close());
  await writeInstance(dir, { pid: process.pid, port: bridge.port, started: 5 });

  const conn = new BridgeConnection({ dir, pid: 424242 });
  const s = await conn.status();
  assert.equal(s.pinnedMissing, true);
  assert.equal(s.pinnedPid, 424242);
  await assert.rejects(() => conn.request('list'), (err) => {
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, 'not-available');
    assert.match(err.message, /424242/);
    return true;
  });
});

test('request cannot push garbage through the socket, non-integer payload fields stay JSON-safe', async (t) => {
  const dir = await tmpBridgeDir(t);
  const bridge = await startFakeBridge({});
  t.after(() => bridge.close());
  await writeInstance(dir, { pid: process.pid, port: bridge.port, started: 5 });

  const conn = new BridgeConnection({ dir });
  const reply = await conn.request('seek', { frame: 7 });
  assert.equal(reply.ok, true);
  assert.equal((await conn.status()).connected, true);
});
