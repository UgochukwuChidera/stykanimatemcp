// Tests for the styk_set_poses tool layer: batch validation, shape stripping,
// ok:false mapping and the round trip over the fake bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BridgeConnection } from '../connection.mjs';
import { startFakeBridge } from './helpers/fake-bridge.mjs';
import { toolSetPoses, normalizePoses, POSE_FIELDS } from '../server.mjs';

async function tmpBridgeDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'styk-bridge-test-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const isTextResult = (result) => Array.isArray(result.content)
  && result.content.length === 1
  && result.content[0].type === 'text';
const errorText = (result) => result.content.find((c) => c.type === 'text')?.text ?? '';

async function connected(t) {
  const dir = await tmpBridgeDir(t);
  const bridge = await startFakeBridge({});
  t.after(() => bridge.close());
  await fsp.writeFile(path.join(dir, `instance-${process.pid}.json`), JSON.stringify({
    bridge: 'styk-agent', schema: 1, port: bridge.port, token: 'test-token',
    pid: process.pid, version: '1.2.3', project: 'demo.styk', started: 1,
  }));
  return { bridge, conn: new BridgeConnection({ dir }) };
}

test('POSE_FIELDS matches the bridge-defined pose vocabulary', () => {
  assert.deepEqual(POSE_FIELDS, ['root_x', 'root_y', 'scale', 'field28', 'color_override_raw']);
});

test('single pose round trip answers the applied count, status and a verify hint', async (t) => {
  const { bridge, conn } = await connected(t);
  const result = await toolSetPoses({ poses: [{ figure: 101, frame: 1, root_x: 40 }] }, conn);
  assert.ok(isTextResult(result), 'an ok reply is a plain text result');
  const body = result.content[0].text;
  assert.match(body, /Applied 1 of 1 pose in one undo step/);
  assert.match(body, /\[revision 7, canUndo: true, canRedo: false, history depth 3\]/);
  assert.match(body, /styk_snapshot or styk_render/, 'points the agent at the observe tools');
  assert.ok(bridge.state.lastOps.includes('pose'), 'exactly one pose op reached the bridge');
  assert.deepEqual(bridge.state.lastPosePayload, [{ figure: 101, frame: 1, root_x: 40 }]);
});

test('a batch of poses is sent as one bridge request and echoes the applied count', async (t) => {
  const { bridge, conn } = await connected(t);
  const result = await toolSetPoses({
    poses: [
      { figure: 101, frame: 1, root_x: 10 },
      { figure: 101, frame: 2, root_x: 20, root_y: 60 },
      { figure: 102, frame: 3, scale: 1.5 },
    ],
  }, conn);
  assert.ok(isTextResult(result));
  assert.match(result.content[0].text, /Applied 3 of 3 poses in one undo step/);
  assert.equal(bridge.state.lastOps.filter((op) => op === 'pose').length, 1, 'one request, not one per pose');
  assert.deepEqual(bridge.state.lastPosePayload.map((pose) => pose.frame), [1, 2, 3]);
});

test('an ok:false reply maps to an isError text result carrying the app\'s wording', async (t) => {
  const { conn } = await connected(t);
  const result = await toolSetPoses({ poses: [{ figure: 0, frame: 1, root_x: 10 }] }, conn);
  assert.equal(result.isError, true, 'the rejection surfaces as a tool error, not a thrown exception');
  assert.match(errorText(result), /bridge rejected 'pose'/);
  assert.match(errorText(result), /The figure is not in keyframe 1\./, 'the app\'s user-facing text survives');
  assert.match(errorText(result), /reason: invalid pose/);
});

test('flat fields are collected per pose and unknown fields are stripped', () => {
  assert.deepEqual(
    normalizePoses([
      { figure: 7, frame: 3, root_x: 12, side: 'evil', dims: { z: 1 }, joints: [1, 2] },
      { figure: 8, frame: 4, patch: { root_y: 9 }, scale: 2 },
      { figure: 9, frame: 5, patch: { scale: 3, bogus: true }, field28: 128 },
    ]),
    [
      { figure: 7, frame: 3, root_x: 12 },
      { figure: 8, frame: 4, root_y: 9, scale: 2 },
      { figure: 9, frame: 5, scale: 3, field28: 128 },
    ],
  );
});

test('batch validation rejects empty, oversized and fieldless poses before the wire', async (t) => {
  const { conn } = await connected(t);
  const clothed = async (poses) => toolSetPoses({ poses }, conn);
  assert.match(errorText(await clothed([])), /poses must be an array of 1–512/);
  const oversized = Array.from({ length: 513 }, () => ({ figure: 1, frame: 1, root_x: 0 }));
  assert.match(errorText(await clothed(oversized)), /poses must be an array of 1–512/);
  assert.match(errorText(await clothed([{ figure: 1, frame: 1 }])), /needs at least one of: root_x, root_y, scale, field28, color_override_raw/);
  assert.match(errorText(await clothed([{ figure: 'x', frame: 1, root_x: 1 }])), /\.figure must be an integer/);
  assert.match(errorText(await clothed([{ figure: 1, frame: 0, root_x: 1 }])), /\.frame must be an integer ≥ 1/);
});
