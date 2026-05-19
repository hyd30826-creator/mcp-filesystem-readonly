# Read-only MCP Filesystem Server

> **This is a hardened read-only fork — no `write_file`, `edit_file`, `move_file`, or `create_directory` tools.**

Node.js server implementing the Model Context Protocol (MCP) for *read-only* filesystem access, with both **stdio** and **Streamable HTTP** transports. The HTTP transport requires an API key and is designed for safe remote access through a local-only port plus a Cloudflare Quick Tunnel.

## Features

- Read files (`read_text_file`, `read_media_file`, `read_multiple_files`)
- Extract text from Office documents, PDFs, and Outlook `.msg` files (`read_document`, `read_documents`)
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
  - Read complete contents of a file as raw UTF-8 text
  - Inputs:
    - `path` (string)
    - `head` (number, optional): First N lines
    - `tail` (number, optional): Last N lines
  - Always treats the file as UTF-8 text regardless of extension
  - For Office documents, PDFs, and `.msg` files use **`read_document`** instead — those come back as garbled binary through this tool
  - Cannot specify both `head` and `tail` simultaneously

- **read_media_file**
  - Read an image or audio file
  - Input: `path` (string)
  - Streams the file and returns base64 data with the corresponding MIME type

- **read_multiple_files**
  - Read multiple files simultaneously
  - Input: `paths` (string[])
  - Failed reads for individual files don't stop the operation

- **read_document**
  - Extract readable text from a document, auto-detecting the format by extension
  - Inputs:
    - `path` (string)
    - `sheets` (Array<string | number>, optional) — XLSX only: filter to specific sheets by name or 0-indexed position. Default: all sheets
    - `maxPages` (number, optional) — PDF only: render at most N pages from the start. Default: all pages
    - `maxChars` (number, optional) — cap extracted text at N characters. Default `500000`; `0` = unlimited
  - Supported extensions and the parser used:

    | Extension(s)                     | Parser                | Output                                  |
    |----------------------------------|-----------------------|-----------------------------------------|
    | `.docx`                          | `mammoth`             | Plain text from paragraphs              |
    | `.xlsx`                          | `exceljs`             | Per-sheet CSV blocks (`# Sheet: name`)  |
    | `.pdf`                           | `pdf-parse`           | Embedded text layer                     |
    | `.msg`                           | `@kenjiuno/msgreader` | `From/To/Cc/Subject/Date` + body + attachments |
    | `.txt`, `.csv`, `.md`, `.markdown`, `.log`, `.json`, `.xml`, `.html`, `.htm` | native | Verbatim UTF-8 (BOM stripped) |

  - Returns `{ text, detectedType, truncated, meta }`. `meta` includes sheet names (XLSX), page count and `hasExtractableText` (PDF), subject / from / attachment list (MSG), or mammoth warnings (DOCX)
  - Image-only/scanned PDFs return empty text with `meta.hasExtractableText: false` — they have no embedded text layer and need OCR (out of scope here)

- **read_documents**
  - Run `read_document` over a batch of paths in one call
  - Inputs:
    - `paths` (string[]) — must be non-empty
    - `maxCharsPerFile` (number, optional) — per-file text cap. Default `200000`; `0` = unlimited
  - Failures on individual files are reported inline (`# <path> (error)\n<message>`) and do not abort the batch

- **list_directory**
  - List directory contents with `[FILE]` or `[DIR]` prefixes
  - Input: `path` (string)

- **list_directory_with_sizes**
  - Like `list_directory` plus file sizes and totals
  - Inputs:
    - `path` (string)
    - `sortBy` (string, optional, `"name"` or `"size"`, default `"name"`)

- **directory_tree**
  - Recursive JSON tree of files/directories with safeguards against token-bombing
  - Returns `{ tree, truncated, totalIncluded }` with optional `reason`/`hint` when truncated
  - Inputs:
    - `path` (string)
    - `excludePatterns` (string[], optional, glob)
    - `maxDepth` (number | null, optional, default `5`) — max recursion depth (0 = root's children only, `null` = unlimited)
    - `maxNodes` (number | null, optional, default `1000`) — max total entries (files + dirs); once hit, stops and marks truncated
    - `maxOutputBytes` (number | null, optional, default `200000`) — max serialized JSON bytes; backstop to prevent huge responses
    - `dirsOnly` (boolean, optional, default `false`) — if true, omit files (only directories)
    - `compact` (boolean, optional, default `true`) — if true, compact JSON; if false, 2-space indented

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
| `read_document`             | `true`       | –              | –               |
| `read_documents`            | `true`       | –              | –               |
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

### Local-only (no tunnel)

If GitHub Copilot / VS Code runs on the **same machine** as the server, skip `cloudflared` and point the client at localhost:

```json
{
  "servers": {
    "filesystem": {
      "type": "http",
      "url": "http://127.0.0.1:8787",
      "headers": {
        "X-API-Key": "<contents of .mcp-api-key>"
      }
    }
  }
}
```

### Copilot: `Server already initialized` / `initialize` fails

If the server log shows `HTTP transport error: Invalid Request: Server already initialized`, the client sent a second `initialize` on the same HTTP session. This server uses **one MCP session per client** (per the MCP Streamable HTTP spec): each new connection gets its own transport.

After updating, **restart** `install.ps1` so `dist/` is rebuilt. Copilot must:

1. Send the first `initialize` without an `Mcp-Session-Id` header.
2. Read `Mcp-Session-Id` from the response headers.
3. Send all later requests (including SSE `GET`) with that same `Mcp-Session-Id` header.

If errors persist, use **localhost** in `mcp.json` (`http://127.0.0.1:8787`) instead of a tunnel while debugging.

### Quick Tunnel troubleshooting

If `cloudflared tunnel --url http://127.0.0.1:8787` fails with:

```text
Error unmarshaling QuickTunnel response: error code: 1101
invalid character 'e' looking for beginning of value
```

that error comes from **Cloudflare's Quick Tunnel API** (`api.trycloudflare.com`), not from this MCP server. Your server is usually fine if `install.ps1` printed `listening on http://127.0.0.1:8787`.

**Check the MCP server first** (replace with your key from `.\.mcp-api-key`):

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8787 -Method POST `
  -Headers @{ "X-API-Key" = (Get-Content .\.mcp-api-key -Raw) } `
  -Body '{}' -UseBasicParsing
```

You should **not** get `401 Unauthorized` when the key is correct.

**Then fix Quick Tunnel:**

1. **Wait and retry** — account-less Quick Tunnels are rate-limited; wait 15–60 minutes and try again.
2. **Update `cloudflared`** — download the latest from the [Cloudflare downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
3. **Remove conflicting config** — if `%USERPROFILE%\.cloudflared\config.yaml` exists, temporarily rename that folder and retry.
4. **Network / DNS** — VPN, corporate proxy, or ISP filtering can block `*.trycloudflare.com`; try another network.
5. **Production alternative** — create a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) with a Cloudflare account (stable URL, no Quick Tunnel rate limits).

**Alternative tunnel (ngrok):**

```powershell
ngrok http 8787
```

Use the printed `https://….ngrok-free.app` URL in `mcp.json` with the same `X-API-Key` header.

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
