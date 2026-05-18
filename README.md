# Read-only MCP Filesystem Server

> **This is a hardened read-only fork — no `write_file`, `edit_file`, `move_file`, or `create_directory` tools.**

Node.js server implementing the Model Context Protocol (MCP) for *read-only* filesystem access, with both **stdio** and **Streamable HTTP** transports. The HTTP transport requires an API key and is designed for safe remote access through a local-only port plus a Cloudflare Quick Tunnel.

## Features

- Read files (`read_text_file`, `read_media_file`, `read_multiple_files`)
- List / search directories (`list_directory`, `list_directory_with_sizes`, `directory_tree`, `search_files`)
- Get file metadata (`get_file_info`)
- Show the configured allowlist (`list_allowed_directories`)
- Dynamic directory access control via [MCP Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots)
- **stdio transport** (default) for local clients (Claude Desktop, VS Code, etc.)
- **Streamable HTTP transport** with mandatory API key authentication for remote / tunneled access

## Directory Access Control

Directories can be specified via command-line arguments or dynamically via [MCP Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots). All filesystem operations are restricted to those directories; symlinks pointing outside them are rejected.

### Command-line arguments
```bash
mcp-filesystem-readonly /path/to/dir1 /path/to/dir2
```

### MCP Roots
Clients that support roots can replace the allowlist dynamically at initialization and via `notifications/roots/list_changed`. If you start the server with no `args` AND the client doesn't support roots, the server will error out during initialization.

## API

### Tools

- **read_text_file**
  - Read complete contents of a file as text
  - Inputs:
    - `path` (string)
    - `head` (number, optional): First N lines
    - `tail` (number, optional): Last N lines
  - Always treats the file as UTF-8 text regardless of extension
  - Cannot specify both `head` and `tail` simultaneously

- **read_media_file**
  - Read an image or audio file
  - Input: `path` (string)
  - Streams the file and returns base64 data with the corresponding MIME type

- **read_multiple_files**
  - Read multiple files simultaneously
  - Input: `paths` (string[])
  - Failed reads for individual files don't stop the operation

- **list_directory**
  - List directory contents with `[FILE]` or `[DIR]` prefixes
  - Input: `path` (string)

- **list_directory_with_sizes**
  - Like `list_directory` plus file sizes and totals
  - Inputs:
    - `path` (string)
    - `sortBy` (string, optional, `"name"` or `"size"`, default `"name"`)

- **directory_tree**
  - Recursive JSON tree of files/directories
  - Inputs:
    - `path` (string)
    - `excludePatterns` (string[], optional, glob)

- **search_files**
  - Recursive glob-style search
  - Inputs:
    - `path` (string)
    - `pattern` (string)
    - `excludePatterns` (string[], optional)

- **get_file_info**
  - Size, timestamps, permissions, type
  - Input: `path` (string)

- **list_allowed_directories**
  - Returns the current allowlist
  - No input

### Tool annotations (MCP hints)

Every tool exposes [MCP ToolAnnotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#toolannotations). Because all write-capable tools have been removed, every tool in this server is `readOnlyHint: true`:

| Tool                        | readOnlyHint | idempotentHint | destructiveHint |
|-----------------------------|--------------|----------------|-----------------|
| `read_text_file`            | `true`       | –              | –               |
| `read_media_file`           | `true`       | –              | –               |
| `read_multiple_files`       | `true`       | –              | –               |
| `list_directory`            | `true`       | –              | –               |
| `list_directory_with_sizes` | `true`       | –              | –               |
| `directory_tree`            | `true`       | –              | –               |
| `search_files`              | `true`       | –              | –               |
| `get_file_info`             | `true`       | –              | –               |
| `list_allowed_directories`  | `true`       | –              | –               |

## Transports

### stdio (default)
```bash
node dist/index.js /path/to/dir1 /path/to/dir2
```

### Streamable HTTP (with API key auth)
```bash
node dist/index.js \
  --http \
  --port 8787 \
  --host 127.0.0.1 \
  --api-key "<your-key>" \
  /path/to/dir1 /path/to/dir2
```

You can also supply the key via the `MCP_API_KEY` environment variable. The server **requires** a key in HTTP mode; if neither `--api-key` nor `MCP_API_KEY` is set it exits with an error.

Every HTTP request must include the key either as:

- `X-API-Key: <your-key>`, or
- `Authorization: Bearer <your-key>`

Comparison is constant-time. Missing or wrong key returns `401 Unauthorized`.

The server binds to `127.0.0.1` by default so it is reachable only from the local machine (or whatever you front it with — see Cloudflare tunnels below). Logs go to stderr so stdio mode stays clean.

CLI flags:

| Flag            | Default       | Description                                            |
|-----------------|---------------|--------------------------------------------------------|
| `--http`        | off           | Enable Streamable HTTP transport                       |
| `--port <n>`    | `8787`        | HTTP port                                              |
| `--host <h>`    | `127.0.0.1`   | Bind address                                           |
| `--api-key <k>` | (env)         | API key (overrides `MCP_API_KEY`)                      |

## Quick install (Windows / PowerShell)

The repo ships with `install.ps1`, which installs dependencies, builds, generates a strong random API key (if you don't supply one), and launches the server in HTTP mode.

```powershell
# HTTP mode (default) — generates a random 48-byte API key
.\install.ps1 -AllowedRoots 'C:\Users\you\projects'

# Multiple roots, custom port
.\install.ps1 -AllowedRoots 'C:\code','D:\notes' -Port 9000

# Provide your own key
.\install.ps1 -AllowedRoots 'C:\code' -ApiKey 'my-existing-key'

# Skip npm install / build if you've already built
.\install.ps1 -AllowedRoots 'C:\code' -SkipInstall

# stdio mode (no key required)
.\install.ps1 -AllowedRoots 'C:\code' -Stdio
```

The script:

1. Verifies Node.js and npm are on `PATH`.
2. Runs `npm install` then `npm run build` (skip with `-SkipInstall`).
3. Validates every `-AllowedRoots` entry exists; aborts loudly if not.
4. Generates a fresh 48-byte URL-safe random API key if none was provided.
5. Saves the key to `.\.mcp-api-key` (already in `.gitignore`).
6. Prints a clearly marked block with the key, a Copilot `mcp.json` snippet, and the matching `cloudflared` command, then launches the server.

## Remote access via Cloudflare Quick Tunnels

A Cloudflare Quick Tunnel exposes your local-only HTTP endpoint as a public `https://<random>.trycloudflare.com` URL — no Cloudflare account needed. Combined with this server's mandatory API key, you get end-to-end TLS + a shared secret.

### One-time setup

1. Install `cloudflared` from <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>.
2. Confirm it's on `PATH`: `cloudflared --version`.

### Run

```powershell
# Terminal 1 — start the MCP server (prints your key)
.\install.ps1 -AllowedRoots 'C:\Users\you\projects'

# Terminal 2 — expose it via a Quick Tunnel
cloudflared tunnel --url http://127.0.0.1:8787
```

`cloudflared` will print a URL like `https://furry-anchor-2024.trycloudflare.com`. Use that as the `url` in your client config.

### Sample Copilot / VS Code `mcp.json`

```json
{
  "servers": {
    "filesystem": {
      "type": "http",
      "url": "https://<your-tunnel>.trycloudflare.com",
      "headers": {
        "X-API-Key": "<your-key>"
      }
    }
  }
}
```

`Authorization: Bearer <your-key>` works equivalently if your client only supports the `Authorization` header.

### Security notes

- **Treat the API key like a password.** Anyone who has both the tunnel URL and the key has read access to your allowed directories.
- **Tunnel URLs are public.** Quick Tunnel URLs are obscure but not secret — assume the URL leaks. The API key is the only thing protecting you.
- **Rotate keys** whenever you suspect leakage. Delete `.\.mcp-api-key` and re-run `install.ps1` (it'll generate a new one) or run it with a new `-ApiKey`.
- The server **binds to `127.0.0.1` by default.** Do not bind to `0.0.0.0` unless you fully understand the consequences; the API key check is the only auth layer.
- This server is *read-only* by construction — even if the key leaks, an attacker cannot modify files inside the allowed roots through MCP. They can, however, exfiltrate file contents.

## Build

```bash
npm install
npm run build
```

## Tests

```bash
npm test
```

## License

MIT — see [LICENSE](./LICENSE).
