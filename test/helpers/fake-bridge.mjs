// Fake loopback implementation of the StykAnimate agent bridge protocol,
// used only by the test suite. Stands up an ephemeral localhost WebSocket
// server speaking the minimal protocol: hello auth, list, invoke (with an
// optional 300ms delay for the 'slow' command to exercise seq correlation),
// undo/redo/seek echo, snapshot, render (1x1 PNG data URLs), and pose (echoes
// the batch size as `applied`; all-new-figures batches answer ok:true).

import http from 'node:http';
import { WebSocketServer } from 'ws';

/** A valid 1×1 PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export async function startFakeBridge({
  token = 'test-token',
  badAuth = false,
  appPid = process.pid,
  version = '1.2.3',
} = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const clients = new Set();
  const state = { connections: 0, lastOps: [] };

  wss.on('connection', (ws) => {
    state.connections++;
    let authed = false;
    const killAuthTimer = setTimeout(() => {
      if (!authed) {
        try { ws.close(4400); } catch { /* ignore */ }
      }
    }, 1000);
    ws.on('close', () => { clearTimeout(killAuthTimer); clients.delete(ws); });
    ws.on('error', () => {});

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        try { ws.close(4400); } catch { /* ignore */ }
        return;
      }

      if (!authed) {
        clearTimeout(killAuthTimer);
        if (msg?.op !== 'hello' || typeof msg.token !== 'string') {
          try { ws.close(4400); } catch { /* ignore */ }
          return;
        }
        if (badAuth || msg.token !== token) {
          try { ws.close(4401); } catch { /* ignore */ }
          return;
        }
        authed = true;
        clients.add(ws);
        ws.send(JSON.stringify({ ok: true, bridge: 'styk-agent', schema: 1, pid: appPid, version }));
        return;
      }

      state.lastOps.push(msg.op);
      const reply = (body, delay = 0) => {
        const send = () => {
          if (ws.readyState !== ws.OPEN) return;
          try { ws.send(JSON.stringify({ seq: msg.seq, ...body })); } catch { /* ignore */ }
        };
        if (delay > 0) setTimeout(send, delay); else send();
      };
      const status = { revision: 7, canUndo: true, canRedo: false, historyDepth: 3 };

      switch (msg.op) {
        case 'list':
          reply({
            ok: true,
            commands: [
              { id: 'file.save', label: 'Save', category: 'file', enabled: true, checked: true },
              { id: 'edit.undo', label: 'Undo', category: 'edit', enabled: true },
              { id: 'render.export', label: 'Export animation', category: 'render', enabled: false, reason: 'no document' },
            ],
            ops: [],
            status,
          });
          break;
        case 'invoke':
          if (msg.command === 'slow') {
            reply({ ok: true, ran: true, command: 'slow', status }, 300);
          } else if (msg.command === 'file.save') {
            reply({ ok: true, ran: true, command: 'file.save', status });
          } else {
            // Matches the real app's behavior for an unrecognized command id.
            reply({ ok: false, ran: false, command: msg.command, error: 'unknown command' });
          }
          break;
        case 'undo':
        case 'redo':
        case 'seek':
          reply({ ok: true, status });
          break;
        case 'snapshot':
          reply({
            ok: true,
            document: {
              revision: 42,
              tick: 5,
              totalTicks: 24,
              fps: 12,
              canvas: { x: 1280, y: 720 },
              backgroundColor: '#ffffff',
              layers: [{ id: 1, name: 'Layer 1', kind: 'figure' }],
              selection: [101],
              objects: [
                {
                  unique_id: 101,
                  figure_type_id: 7,
                  root_x: 60.5,
                  root_y: 120.25,
                  scale: 1,
                  color_override_raw: 0xffaa00,
                  field28: 0,
                  name: 'stickman',
                },
              ],
            },
            status,
          });
          break;
        case 'render':
          reply({
            ok: true,
            frames: (Array.isArray(msg.frames) ? msg.frames : []).map((f) => ({
              frame: f,
              image: `data:image/png;base64,${TINY_PNG.toString('base64')}`,
            })),
          });
          break;
        case 'pose': {
          // Mirrors the real app's shape: echo the batch size on ok, and answer
          // the app's user-facing validation text on a bad figure id. The
          // received batch is kept in state.lastPosePayload for tool-layer tests.
          const poses = Array.isArray(msg.poses) ? msg.poses : [];
          state.lastPosePayload = poses;
          if (poses.length === 0) {
            reply({ ok: false, error: 'poses must be a non-empty array of {figure, frame, patch...}', reason: 'invalid pose' });
          } else if (poses.some((p) => !Number.isInteger(p?.figure) || p.figure < 1)) {
            reply({ ok: false, error: 'The figure is not in keyframe 1.', reason: 'invalid pose' });
          } else {
            reply({ ok: true, applied: poses.length, status });
          }
          break;
        }
        default:
          reply({ ok: false, error: 'unknown command' });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    token,
    state,
    closeClients: (code = 1001) => {
      for (const ws of [...clients]) {
        try { ws.close(code); } catch { /* ignore */ }
      }
    },
    close: () => {
      for (const ws of [...clients]) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
      return new Promise((resolve) => {
        wss.close(() => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        });
      });
    },
  };
}
