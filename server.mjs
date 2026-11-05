// server.mjs — stdio MCP server exposing the StykAnimate agent bridge as tools.
// Logs go to stderr only; stdout carries MCP framing exclusively.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

import { BridgeConnection } from './connection.mjs';

const SERVER_NAME = 'styk-animate-mcp';
const SERVER_VERSION = '0.1.0';
const LIST_TRUNCATE_AT = 300;

const log = (...parts) => {
  process.stderr.write(`[${SERVER_NAME}] ${parts.join(' ')}\n`);
};

const LIST_CATEGORY_ORDER = [
  'file', 'edit', 'animation', 'timeline', 'view', 'tools', 'help',
];

const TOOLS = [
  {
    name: 'styk_status',
    description:
      'Report StykAnimate agent-bridge state without contacting the app: whether the Assistant connection is on, ' +
      'each discovered app instance (pid, version, project), which instance the server would talk to, and whether ' +
      'the MCP server currently holds a connection to it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'styk_list_commands',
    description:
      'List the commands the running StykAnimate app exposes, with category, enabled state and availability reason. ' +
      'Optional substring filter on command id or label.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Case-insensitive substring match on command id or label (optional).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'styk_invoke',
    description:
      'Run one app command in StykAnimate exactly as if the user clicked the menu entry. Use styk_list_commands to discover valid ids.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command id (see styk_list_commands).' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'styk_undo',
    description: 'Undo the last editing action in StykAnimate.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'styk_redo',
    description: 'Redo the most recently undone action in StykAnimate.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'styk_seek',
    description: 'Jump the StykAnimate timeline to a frame (1-based positive integer).',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'integer', minimum: 1, description: 'Frame to seek to, starting at 1.' },
      },
      required: ['frame'],
      additionalProperties: false,
    },
  },
  {
    name: 'styk_snapshot',
    description:
      'Get a JSON overview of the StykAnimate document: revision, current tick, fps, canvas, background color, ' +
      'layers, selection and objects (capped at 512 by the app).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'styk_render',
    description:
      'Render up to 8 specific frames of the StykAnimate animation as PNG preview images (max 512px). ' +
      'Omit frames to render the current frame.',
    inputSchema: {
      type: 'object',
      properties: {
        frames: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          maxItems: 8,
          description: '1-based frame numbers to render (1–8 of them). Defaults to the current frame.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'styk_set_poses',
    description:
      'Pose figures numerically in StykAnimate: set root position (root_x/root_y), scale, opacity (field28) or ' +
      'color override for figures at frames. One batch applies as a single undo step; the whole batch is ' +
      'validated first, so one bad pose changes nothing. Verify visual results with styk_snapshot / styk_render.',
    inputSchema: {
      type: 'object',
      properties: {
        poses: {
          type: 'array',
          minItems: 1,
          maxItems: 512,
          description: 'The pose batch (1–512 entries, applied together).',
          items: {
            type: 'object',
            properties: {
              figure: { type: 'integer', description: 'The figure\'s unique_id (see styk_snapshot).' },
              frame: { type: 'integer', minimum: 1, description: 'Target frame, 1-based. The figure must exist in that frame.' },
              root_x: { type: 'number', description: 'New root X position (optional).' },
              root_y: { type: 'number', description: 'New root Y position (optional).' },
              scale: { type: 'number', minimum: 0, description: 'New figure scale (optional).' },
              field28: { type: 'integer', minimum: 0, maximum: 255, description: 'Opacity byte (optional).' },
              color_override_raw: { type: 'integer', description: 'Color override as raw 32-bit ARGB (optional).' },
            },
            required: ['figure', 'frame'],
          },
        },
      },
      required: ['poses'],
      additionalProperties: false,
    },
  },
];

const connection = new BridgeConnection();

// — result helpers (never throw across the SDK boundary) ——————————————

const text = (t) => ({ type: 'text', text: t });
const textResult = (t) => ({ content: [text(t)] });
const errorResult = (t) => ({ content: [text(t)], isError: true });

/** Bridge said ok:false — surface the error verbatim as an isError text block. */
function bridgeErrorResult(reply, op) {
  const err = reply && typeof reply.error === 'string' ? reply.error : JSON.stringify(reply ?? {});
  const reason = reply && reply.reason ? ` (reason: ${reply.reason})` : '';
  return errorResult(`StykAnimate bridge rejected '${op}': ${err}${reason}`);
}

function statusLine(status) {
  if (!status || typeof status !== 'object') return '';
  const bits = [];
  if (Number.isInteger(status.revision)) bits.push(`revision ${status.revision}`);
  if ('canUndo' in status) bits.push(`canUndo: ${status.canUndo}`);
  if ('canRedo' in status) bits.push(`canRedo: ${status.canRedo}`);
  if (Number.isInteger(status.historyDepth)) bits.push(`history depth ${status.historyDepth}`);
  return bits.length ? ` [${bits.join(', ')}]` : '';
}

// — tool implementations ————————————————————————————————————————————

async function toolStatus() {
  const s = await connection.status();
  const lines = [];
  if (!s.running) {
    lines.push(`StykAnimate bridge: OFF — no live instance records in ${s.dir}.`);
    lines.push('Open StykAnimate and turn on Settings → Assistant connection, then try again.');
  } else {
    lines.push(`StykAnimate bridge: ON — ${s.instances.length} app instance(s) found:`);
    for (const i of s.instances) {
      lines.push(`  - pid ${i.pid}, ${i.name} v${i.version}, project: ${i.project ?? '(unknown)'}` +
        `${s.selected && s.selected.pid === i.pid ? '  ← will connect here' : ''}`);
    }
    if (s.pinnedPid) {
      lines.push(`Instance pinned via STYK_BRIDGE_PID=${s.pinnedPid}.`);
      if (s.pinnedMissing) lines.push('Warning: the pinned pid is not among the live instances.');
    }
    lines.push(`MCP connection: ${s.connected
      ? `connected to pid ${s.connection.pid} (${s.connection.version})`
      : 'not connected yet — connects lazily on the first tool call'}.`);
  }
  for (const w of s.warnings) lines.push(`Note: ${w}`);
  if (s.lastClose) lines.push(`Last disconnect: ${connection.closeError(s.lastClose.code).message}.`);
  return textResult(lines.join('\n'));
}

async function toolListCommands(args) {
  const reply = await connection.request('list');
  if (!reply.ok) return bridgeErrorResult(reply, 'list');
  const all = Array.isArray(reply.commands) ? reply.commands : [];
  const filter = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : '';
  let commands = filter
    ? all.filter((c) => `${c?.id ?? ''} ${c?.label ?? ''}`.toLowerCase().includes(filter))
    : all;
  let truncated = false;
  if (commands.length > LIST_TRUNCATE_AT) {
    commands = commands.slice(0, LIST_TRUNCATE_AT);
    truncated = true;
  }
  const lines = commands.map((c) => {
    const state = c.enabled === false ? 'disabled' : 'enabled';
    const reason = !c.enabled && c.reason ? ` — ${c.reason}` : '';
    const checked = c.checked ? ' [checked]' : '';
    const category = c.category ? ` [${c.category}]` : '';
    return `${c.id} — ${c.label ?? ''}${category}${checked} (${state}${reason})`;
  });
  if (truncated) lines.push(`… list truncated at ${LIST_TRUNCATE_AT} of ${all.length}${filter ? ' matching' : ' total'} entries; narrow with "filter" to see more.`);
  if (lines.length === 0) lines.push(filter ? `No commands match "${args.filter}".` : 'The app exposes no commands right now.');
  return textResult(lines.join('\n'));
}

async function toolInvoke(args) {
  const reply = await connection.request('invoke', { command: args.command });
  if (!reply.ok) return bridgeErrorResult(reply, 'invoke');
  return textResult(`Command '${args.command}' ran.${statusLine(reply.status)}`);
}

async function toolUndo() {
  const reply = await connection.request('undo');
  if (!reply.ok) return bridgeErrorResult(reply, 'undo');
  return textResult(`Undo done.${statusLine(reply.status)}`);
}

async function toolRedo() {
  const reply = await connection.request('redo');
  if (!reply.ok) return bridgeErrorResult(reply, 'redo');
  return textResult(`Redo done.${statusLine(reply.status)}`);
}

async function toolSeek(args) {
  const frame = args.frame;
  if (!Number.isInteger(frame) || frame < 1) {
    return errorResult(`Seek needs an integer frame ≥ 1, got ${JSON.stringify(frame)}.`);
  }
  const reply = await connection.request('seek', { frame });
  if (!reply.ok) return bridgeErrorResult(reply, 'seek');
  const landed = Number.isInteger(reply.frame) ? reply.frame : frame;
  return textResult(`Seeked to frame ${landed}.${statusLine(reply.status)}`);
}

async function toolSnapshot() {
  const reply = await connection.request('snapshot');
  if (!reply.ok) return bridgeErrorResult(reply, 'snapshot');
  const payload = { document: reply.document ?? null, status: reply.status ?? null };
  return textResult(JSON.stringify(payload, null, 2));
}

async function toolRender(args) {
  let frames = args.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    // Default: render whatever frame the app is currently showing (tick).
    const snap = await connection.request('snapshot');
    if (!snap.ok) return bridgeErrorResult(snap, 'snapshot');
    frames = [Math.max(1, Math.floor(snap.document?.tick ?? 1))];
  }
  const valid = [...new Set(frames.filter((f) => Number.isInteger(f) && f >= 1))].slice(0, 8);
  if (valid.length === 0) {
    return errorResult(`styk_render needs 1–8 frame numbers (integers ≥ 1); got ${JSON.stringify(frames)}.`);
  }
  const reply = await connection.request('render', { frames: valid });
  if (!reply.ok) return bridgeErrorResult(reply, 'render');

  const content = [];
  const returned = Array.isArray(reply.frames) ? reply.frames : [];
  for (const f of returned) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(f?.image ?? '');
    if (m) content.push({ type: 'image', mimeType: 'image/png', data: m[1] });
  }
  const rendered = returned.map((f) => f.frame).filter(Number.isInteger);
  content.push(text(`Rendered ${rendered.length ? `frames ${rendered.join(', ')}` : 'no frames'} as PNG previews.`));
  return { content };
}

// — pose tool (styk_set_poses) ———————————————————————————————————————

/** The only fields the bridge's `pose` op accepts on a pose entry. */
export const POSE_FIELDS = ['root_x', 'root_y', 'scale', 'field28', 'color_override_raw'];

/**
 * Validate a pose batch for the `pose` op and strip every field it does not
 * accept. Each entry keeps `figure` and `frame`; allowed values may sit flat on
 * the entry (root_x: 40) or inside an optional `patch` object. At least one
 * allowed field must be present per entry. Throws a plain Error with a
 * tool-consumer message; the tool layer turns that into an isError result.
 */
export function normalizePoses(poses) {
  if (!Array.isArray(poses) || poses.length === 0 || poses.length > 512) {
    throw new Error(`poses must be an array of 1–512 pose entries, got ${JSON.stringify(poses)}.`);
  }
  return poses.map((pose, index) => {
    if (!pose || typeof pose !== 'object') {
      throw new Error(`poses[${index}] must be an object, got ${JSON.stringify(pose)}.`);
    }
    if (!Number.isInteger(pose.figure)) {
      throw new Error(`poses[${index}].figure must be an integer (the figure's unique_id), got ${JSON.stringify(pose.figure)}.`);
    }
    if (!Number.isInteger(pose.frame) || pose.frame < 1) {
      throw new Error(`poses[${index}].frame must be an integer ≥ 1, got ${JSON.stringify(pose.frame)}.`);
    }
    const fields = {};
    for (const source of [pose.patch, pose]) {
      if (!source || typeof source !== 'object') continue;
      for (const field of POSE_FIELDS) {
        if (source[field] !== undefined) fields[field] = source[field];
      }
    }
    if (Object.keys(fields).length === 0) {
      throw new Error(`poses[${index}] needs at least one of: ${POSE_FIELDS.join(', ')}.`);
    }
    return { figure: pose.figure, frame: pose.frame, ...fields };
  });
}

export async function toolSetPoses(args, client = connection) {
  let poses;
  try {
    poses = normalizePoses(args?.poses);
  } catch (err) {
    return errorResult(`styk_set_poses: ${err.message}`);
  }
  // One bridge request for the whole batch; the app answers ok:false with the
  // app's own user-facing validation text when anything is wrong.
  const reply = await client.request('pose', { poses });
  if (!reply.ok) return bridgeErrorResult(reply, 'pose');
  const applied = Number.isInteger(reply.applied) ? reply.applied : poses.length;
  return textResult(
    `Applied ${applied} of ${poses.length} pose${poses.length === 1 ? '' : 's'} in one undo step${statusLine(reply.status)}.\n` +
    'Verify the result with styk_snapshot or styk_render.',
  );
}

const HANDLERS = {
  styk_status: toolStatus,
  styk_list_commands: toolListCommands,
  styk_invoke: toolInvoke,
  styk_undo: toolUndo,
  styk_redo: toolRedo,
  styk_seek: toolSeek,
  styk_snapshot: toolSnapshot,
  styk_render: toolRender,
  styk_set_poses: toolSetPoses,
};

// — wiring ————————————————————————————————————————————————————————————

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return errorResult(`Unknown tool '${name}'. Known tools: ${Object.keys(HANDLERS).join(', ')}.`);
  }
  try {
    return await handler(args);
  } catch (err) {
    // BridgeError and anything else — reported as an error result, never thrown.
    const detail = err instanceof Error ? err.message : String(err);
    log(`tool ${name} failed: ${detail}`);
    return errorResult(`styk-animate-mcp: ${detail}`);
  }
});

// Only run the stdio transport when this file is the entry point, so tests can
// import the tool-layer helpers without starting the server.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // Keep stderr-only logging for unexpected async failures; never crash stdio.
  process.on('uncaughtException', (err) => log('uncaughtException:', err?.stack ?? err));
  process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.stack ?? err));

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`got ${signal}, shutting down`);
    try {
      connection.close();
    } catch { /* ignore */ }
    try {
      server.close();
    } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready (v${SERVER_VERSION}); waiting for MCP client`);
}
