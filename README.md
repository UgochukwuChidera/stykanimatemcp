# styk-animate-mcp

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that lets MCP clients —
for example Claude Desktop — drive the **StykAnimate** desktop app through its local **agent bridge**
(toggle in the app: *Settings → Assistant connection*).

It is a thin, private wrapper: everything stays on your machine. The server only talks over
`127.0.0.1:…` to the running StykAnimate app; nothing is sent to the internet.

This project is licensed under the [GNU General Public License, version 3 or later](LICENSE).

## How it works

When the Assistant connection toggle is on, StykAnimate writes a discovery record to
`~/.styk-animate/bridge/instance-<pid>.json` containing `{bridge, schema, port, token, pid, …}`.
This server:

1. scans that directory (dead processes' records are swept away automatically),
2. picks an app instance — the most recently started one, or the one pinned via the
   `STYK_BRIDGE_PID` environment variable,
3. connects to `ws://127.0.0.1:<port>/bridge`, authenticates with the `hello` handshake using the
   record's token,
4. runs request/reply ops (`list`, `invoke`, `undo`, `redo`, `pose`, `seek`, `snapshot`, `render`)
   keyed by a monotonically increasing `seq` counter, and reconnects transparently on the next
   tool call after any disconnect.

## Install

Requires Node.js **≥ 20**.

```sh
cd styk-animate-mcp
npm install
```

## Run

```sh
node server.mjs
```

The server speaks MCP over stdio, so you normally let the MCP client start it. If you run it by
hand for testing, it will start and wait quietly (log lines go to stderr only); stop it with
Ctrl-C (SIGINT) for a clean shutdown.

## Configure Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "styk-animate": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/styk-animate-mcp/server.mjs"]
    }
  }
}
```

Use the *absolute* paths — `which node` gives the node path on Linux/macOS; on Windows use the
absolute path to `node.exe` and to the repo checkout. Restart Claude Desktop afterwards.

## The one user step you must not skip

**Turn on the toggle first**: open StykAnimate and switch on *Settings → Assistant connection*
*before* asking the MCP client to use these tools. With no running bridge, tools answer
gracefully (e.g. `styk_status` reports "bridge OFF") but the editing tools cannot do anything.

## Tools

| Tool | What it does |
| --- | --- |
| `styk_status` | Bridge/discovery state: instances found (pid, version, project), which one will be used, MCP connection state. Works with no app running. |
| `styk_list_commands` | The app's command list with categories, enabled state and availability reasons; optional `filter` (substring on id/label) when the list gets long. |
| `styk_invoke` | Run one app command by id — exactly like clicking the menu entry. |
| `styk_undo` / `styk_redo` | Undo / redo the last editing action. |
| `styk_seek` | Jump the timeline to a frame (1-based). |
| `styk_snapshot` | Structured JSON overview of the document: revision, tick, fps, canvas, layers, selection, objects. |
| `styk_render` | Render 1–8 frames as PNG preview images (≤512px), returned as MCP image content blocks. Omit `frames` to render the current frame. |
| `styk_set_poses` | Pose figures numerically (root position, scale, opacity, color override) by figure and 1-based frame — one batch becomes a single undo step. |

## Environment variables

| Variable | Meaning |
| --- | --- |
| `STYK_BRIDGE_PID` | Pin a specific app instance by pid instead of "most recently started". |
| `STYK_BRIDGE_DIR` | Override the discovery directory (default `~/.styk-animate/bridge/`). |

## Troubleshooting

- **"Bridge OFF / no instance records found"** — the toggle is off or the app is closed.
  Open StykAnimate and turn on *Settings → Assistant connection*.
- **Close code 4401 ("rejected the token")** — the record's token is stale, e.g. the app was
  restarted. Turn the Assistant connection toggle off and on again, or restart the app; the
  discovery record is rewritten and the server picks the new token on its next attempt.
- **Close code 4403** — temporary lockout after repeated auth failures. Wait a little, or
  restart the app, and make sure only up-to-date record files sit in `~/.styk-animate/bridge/`.
- **Close code 4409** — schema mismatch: the desktop app and this MCP server versions do not
  agree on the bridge protocol. Update whichever is older.
- **Multiple apps open** — the MCP server talks to the most recently launched instance; set
  `STYK_BRIDGE_PID` (`styk_status` shows the candidates with their pids) to be explicit.
- **Server hangs or exits oddly** — diagnostic log lines go to stderr; run `node server.mjs`
  by hand in a terminal and watch stderr for clues.

## Development

```sh
npm test          # node --test: protocol tests against an in-process fake bridge
```

The tests never touch the real `~/.styk-animate` directory — the discovery path is fully
injectable (option/env), and the WebSocket protocol is exercised against a local fake server.
