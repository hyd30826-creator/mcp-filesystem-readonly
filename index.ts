#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolResult,
  RootsListChangedNotificationSchema,
  isInitializeRequest,
  type Root,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import { createReadStream } from "fs";
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "path";
import { z } from "zod";
import { minimatch } from "minimatch";
import { normalizePath, expandHome } from './path-utils.js';
import { getValidRootDirectories } from './roots-utils.js';
import {
  formatSize,
  validatePath,
  getFileStats,
  readFileContent,
  searchFilesWithValidation,
  tailFile,
  headFile,
  setAllowedDirectories,
} from './lib.js';

// CLI parsing

interface CliOptions {
  http: boolean;
  port: number;
  host: string;
  apiKey: string | undefined;
  roots: string[];
}

function printUsage(): void {
  console.error("Usage: mcp-server-filesystem [options] <allowed-directory> [additional-directories...]");
  console.error("");
  console.error("Read-only MCP filesystem server.");
  console.error("");
  console.error("Options:");
  console.error("  --http               Enable Streamable HTTP transport (requires --api-key or MCP_API_KEY)");
  console.error("  --port <n>           HTTP port (default: 8787)");
  console.error("  --host <host>        HTTP bind host (default: 127.0.0.1)");
  console.error("  --api-key <key>      API key required by HTTP clients (alternative: MCP_API_KEY env var)");
  console.error("  -h, --help           Show this help");
  console.error("");
  console.error("Without --http the server uses stdio transport (default).");
  console.error("Allowed directories can also be provided dynamically via the MCP roots protocol.");
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    http: false,
    port: 8787,
    host: '127.0.0.1',
    apiKey: undefined,
    roots: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--http':
        opts.http = true;
        break;
      case '--port': {
        const val = argv[++i];
        const n = Number(val);
        if (!Number.isInteger(n) || n <= 0 || n > 65535) {
          console.error(`Error: invalid --port value: ${val}`);
          process.exit(2);
        }
        opts.port = n;
        break;
      }
      case '--host': {
        const val = argv[++i];
        if (!val) {
          console.error("Error: --host requires a value");
          process.exit(2);
        }
        opts.host = val;
        break;
      }
      case '--api-key': {
        const val = argv[++i];
        if (!val) {
          console.error("Error: --api-key requires a value");
          process.exit(2);
        }
        opts.apiKey = val;
        break;
      }
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        opts.roots.push(a);
    }
  }

  return opts;
}

const cli = parseCli(process.argv.slice(2));
const httpApiKey = cli.apiKey ?? process.env.MCP_API_KEY;

if (cli.http && !httpApiKey) {
  console.error("Error: HTTP transport requires an API key. Provide --api-key <key> or set MCP_API_KEY.");
  process.exit(2);
}

if (cli.roots.length === 0) {
  console.error("Usage: mcp-server-filesystem [options] [allowed-directory] [additional-directories...]");
  console.error("Note: Allowed directories can be provided via:");
  console.error("  1. Command-line arguments (shown above)");
  console.error("  2. MCP roots protocol (if client supports it)");
  console.error("At least one directory must be provided by EITHER method for the server to operate.");
}

// Store allowed directories in normalized and resolved form
// We store BOTH the original path AND the resolved path to handle symlinks correctly
// This fixes the macOS /tmp -> /private/tmp symlink issue where users specify /tmp
// but the resolved path is /private/tmp
let allowedDirectories = (await Promise.all(
  cli.roots.map(async (dir) => {
    const expanded = expandHome(dir);
    const absolute = path.resolve(expanded);
    const normalizedOriginal = normalizePath(absolute);
    try {
      // Security: Resolve symlinks in allowed directories during startup
      // This ensures we know the real paths and can validate against them later
      const resolved = await fs.realpath(absolute);
      const normalizedResolved = normalizePath(resolved);
      if (normalizedOriginal !== normalizedResolved) {
        return [normalizedOriginal, normalizedResolved];
      }
      return [normalizedResolved];
    } catch (error) {
      // If we can't resolve (doesn't exist), use the normalized absolute path
      // This allows configuring allowed dirs that will be created later
      return [normalizedOriginal];
    }
  })
)).flat();

// Filter to only accessible directories, warn about inaccessible ones
const accessibleDirectories: string[] = [];
for (const dir of allowedDirectories) {
  try {
    const stats = await fs.stat(dir);
    if (stats.isDirectory()) {
      accessibleDirectories.push(dir);
    } else {
      console.error(`Warning: ${dir} is not a directory, skipping`);
    }
  } catch (error) {
    console.error(`Warning: Cannot access directory ${dir}, skipping`);
  }
}

if (accessibleDirectories.length === 0 && allowedDirectories.length > 0) {
  console.error("Error: None of the specified directories are accessible");
  process.exit(1);
}

allowedDirectories = accessibleDirectories;

setAllowedDirectories(allowedDirectories);

// Schema definitions

const ReadTextFileArgsSchema = z.object({
  path: z.string(),
  tail: z.number().optional().describe('If provided, returns only the last N lines of the file'),
  head: z.number().optional().describe('If provided, returns only the first N lines of the file')
});

const ReadMediaFileArgsSchema = z.object({
  path: z.string()
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z
    .array(z.string())
    .min(1, "At least one file path must be provided")
    .describe("Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories."),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
  path: z.string(),
  sortBy: z.enum(['name', 'size']).optional().default('name').describe('Sort entries by name or size'),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
  maxDepth: z.number().nullable().optional().default(5)
    .describe("Max recursion depth (0 = root's children only). null = unlimited."),
  maxNodes: z.number().nullable().optional().default(1000)
    .describe("Max total entries (files + dirs). null = unlimited. Once hit, stop adding entries and mark truncated."),
  maxOutputBytes: z.number().nullable().optional().default(200000)
    .describe("Max serialized JSON bytes. null = unlimited. Backstop to prevent token-bombing."),
  dirsOnly: z.boolean().optional().default(false)
    .describe("If true, omit files from the tree (only directories)."),
  compact: z.boolean().optional().default(true)
    .describe("If true (default), use compact JSON (no indentation). If false, use 2-space indentation."),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

function createFilesystemMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "secure-filesystem-server-readonly",
      version: "0.3.0",
    }
  );

// Reads a file as a stream of buffers, concatenates them, and then encodes
// the result to a Base64 string. This is a memory-efficient way to handle
// binary data from a stream before the final encoding.
async function readFileAsBase64Stream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(chunk as Buffer);
    });
    stream.on('end', () => {
      const finalBuffer = Buffer.concat(chunks);
      resolve(finalBuffer.toString('base64'));
    });
    stream.on('error', (err) => reject(err));
  });
}

// Tool registrations (read-only only)

const readTextFileHandler = async (args: z.infer<typeof ReadTextFileArgsSchema>) => {
  const validPath = await validatePath(args.path);

  if (args.head && args.tail) {
    throw new Error("Cannot specify both head and tail parameters simultaneously");
  }

  let content: string;
  if (args.tail) {
    content = await tailFile(validPath, args.tail);
  } else if (args.head) {
    content = await headFile(validPath, args.head);
  } else {
    content = await readFileContent(validPath);
  }

  return {
    content: [{ type: "text" as const, text: content }],
    structuredContent: { content }
  };
};

server.registerTool(
  "read_text_file",
  {
    title: "Read Text File",
    description:
      "Read the complete contents of a file from the file system as text. " +
      "Handles various text encodings and provides detailed error messages " +
      "if the file cannot be read. Use this tool when you need to examine " +
      "the contents of a single file. Use the 'head' parameter to read only " +
      "the first N lines of a file, or the 'tail' parameter to read only " +
      "the last N lines of a file. Operates on the file as text regardless of extension. " +
      "Only works within allowed directories.",
    inputSchema: {
      path: z.string(),
      tail: z.number().optional().describe("If provided, returns only the last N lines of the file"),
      head: z.number().optional().describe("If provided, returns only the first N lines of the file")
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true }
  },
  readTextFileHandler
);

server.registerTool(
  "read_media_file",
  {
    title: "Read Media File",
    description:
      "Read an image or audio file. Returns the base64 encoded data and MIME type. " +
      "Only works within allowed directories.",
    inputSchema: {
      path: z.string()
    },
    outputSchema: {
      content: z.array(z.object({
        type: z.enum(["image", "audio", "blob"]),
        data: z.string(),
        mimeType: z.string()
      }))
    },
    annotations: { readOnlyHint: true }
  },
  async (args: z.infer<typeof ReadMediaFileArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const extension = path.extname(validPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
    };
    const mimeType = mimeTypes[extension] || "application/octet-stream";
    const data = await readFileAsBase64Stream(validPath);

    const type = mimeType.startsWith("image/")
      ? "image"
      : mimeType.startsWith("audio/")
        ? "audio"
        // Fallback for other binary types, not officially supported by the spec but has been used for some time
        : "blob";
    const contentItem = { type: type as 'image' | 'audio' | 'blob', data, mimeType };
    return {
      content: [contentItem],
      structuredContent: { content: [contentItem] }
    } as unknown as CallToolResult;
  }
);

server.registerTool(
  "read_multiple_files",
  {
    title: "Read Multiple Files",
    description:
      "Read the contents of multiple files simultaneously. This is more " +
      "efficient than reading files one by one when you need to analyze " +
      "or compare multiple files. Each file's content is returned with its " +
      "path as a reference. Failed reads for individual files won't stop " +
      "the entire operation. Only works within allowed directories.",
    inputSchema: {
      paths: z.array(z.string())
        .min(1)
        .describe("Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories.")
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true }
  },
  async (args: z.infer<typeof ReadMultipleFilesArgsSchema>) => {
    const results = await Promise.all(
      args.paths.map(async (filePath: string) => {
        try {
          const validPath = await validatePath(filePath);
          const content = await readFileContent(validPath);
          return `${filePath}:\n${content}\n`;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return `${filePath}: Error - ${errorMessage}`;
        }
      }),
    );
    const text = results.join("\n---\n");
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text }
    };
  }
);

server.registerTool(
  "list_directory",
  {
    title: "List Directory",
    description:
      "Get a detailed listing of all files and directories in a specified path. " +
      "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
      "prefixes. This tool is essential for understanding directory structure and " +
      "finding specific files within a directory. Only works within allowed directories.",
    inputSchema: {
      path: z.string()
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true }
  },
  async (args: z.infer<typeof ListDirectoryArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const entries = await fs.readdir(validPath, { withFileTypes: true });
    const formatted = entries
      .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
      .join("\n");
    return {
      content: [{ type: "text" as const, text: formatted }],
      structuredContent: { content: formatted }
    };
  }
);

server.registerTool(
  "list_directory_with_sizes",
  {
    title: "List Directory with Sizes",
    description:
      "Get a detailed listing of all files and directories in a specified path, including sizes. " +
      "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
      "prefixes. This tool is useful for understanding directory structure and " +
      "finding specific files within a directory. Only works within allowed directories.",
    inputSchema: {
      path: z.string(),
      sortBy: z.enum(["name", "size"]).optional().default("name").describe("Sort entries by name or size")
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true }
  },
  async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const entries = await fs.readdir(validPath, { withFileTypes: true });

    const detailedEntries = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(validPath, entry.name);
        try {
          const stats = await fs.stat(entryPath);
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            mtime: stats.mtime
          };
        } catch (error) {
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: 0,
            mtime: new Date(0)
          };
        }
      })
    );

    const sortedEntries = [...detailedEntries].sort((a, b) => {
      if (args.sortBy === 'size') {
        return b.size - a.size;
      }
      return a.name.localeCompare(b.name);
    });

    const formattedEntries = sortedEntries.map(entry =>
      `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.name.padEnd(30)} ${
        entry.isDirectory ? "" : formatSize(entry.size).padStart(10)
      }`
    );

    const totalFiles = detailedEntries.filter(e => !e.isDirectory).length;
    const totalDirs = detailedEntries.filter(e => e.isDirectory).length;
    const totalSize = detailedEntries.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size), 0);

    const summary = [
      "",
      `Total: ${totalFiles} files, ${totalDirs} directories`,
      `Combined size: ${formatSize(totalSize)}`
    ];

    const text = [...formattedEntries, ...summary].join("\n");
    const contentBlock = { type: "text" as const, text };
    return {
      content: [contentBlock],
      structuredContent: { content: text }
    };
  }
);

server.registerTool(
  "directory_tree",
  {
    title: "Directory Tree",
    description:
      "Get a recursive tree view of files and directories as a JSON structure. " +
      "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
      "Returns { tree, truncated, totalIncluded } with optional reason/hint when truncated. " +
      "Defaults: maxDepth=5, maxNodes=1000, maxOutputBytes=200KB, compact=true. " +
      "For large directories, narrow the path or use excludePatterns. " +
      "Set dirsOnly=true to omit files. Only works within allowed directories.",
    inputSchema: {
      path: z.string(),
      excludePatterns: z.array(z.string()).optional().default([]),
      maxDepth: z.number().nullable().optional().default(5)
        .describe("Max recursion depth (0 = root's children only). null = unlimited."),
      maxNodes: z.number().nullable().optional().default(1000)
        .describe("Max total entries (files + dirs). null = unlimited. Once hit, stop adding entries and mark truncated."),
      maxOutputBytes: z.number().nullable().optional().default(200000)
        .describe("Max serialized JSON bytes. null = unlimited. Backstop to prevent token-bombing."),
      dirsOnly: z.boolean().optional().default(false)
        .describe("If true, omit files from the tree (only directories)."),
      compact: z.boolean().optional().default(true)
        .describe("If true (default), use compact JSON (no indentation). If false, use 2-space indentation."),
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true }
  },
  async (args: z.infer<typeof DirectoryTreeArgsSchema>) => {
    interface TreeEntry {
      name: string;
      type: 'file' | 'directory';
      children?: TreeEntry[];
    }
    const rootPath = args.path;
    const maxDepth = args.maxDepth;
    const maxNodes = args.maxNodes;
    const maxOutputBytes = args.maxOutputBytes;
    const dirsOnly = args.dirsOnly;
    const compact = args.compact;

    const counter = { count: 0 };
    let truncated = false;
    let truncationReason: string | undefined;

    async function buildTree(
      currentPath: string,
      excludePatterns: string[],
      depth: number
    ): Promise<TreeEntry[]> {
      const validPath = await validatePath(currentPath);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      const result: TreeEntry[] = [];

      for (const entry of entries) {
        if (truncated) break;

        const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
        const shouldExclude = excludePatterns.some(pattern => {
          if (pattern.includes('*')) {
            return minimatch(relativePath, pattern, { dot: true });
          }
          return minimatch(relativePath, pattern, { dot: true }) ||
            minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
            minimatch(relativePath, `**/${pattern}/**`, { dot: true });
        });
        if (shouldExclude)
          continue;

        if (dirsOnly && !entry.isDirectory())
          continue;

        if (maxNodes !== null && counter.count >= maxNodes) {
          truncated = true;
          truncationReason = "maxNodes";
          break;
        }

        counter.count++;

        const entryData: TreeEntry = {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file'
        };

        if (entry.isDirectory()) {
          if (maxDepth !== null && depth >= maxDepth) {
            entryData.children = [];
          } else {
            const subPath = path.join(currentPath, entry.name);
            entryData.children = await buildTree(subPath, excludePatterns, depth + 1);
          }
        }

        result.push(entryData);
      }

      return result;
    }

    const treeData = await buildTree(rootPath, args.excludePatterns, 0);

    type TreeResult = {
      tree: TreeEntry[];
      truncated: boolean;
      totalIncluded: number;
      reason?: string;
      hint?: string;
    };

    let result: TreeResult;
    if (truncated) {
      result = {
        tree: treeData,
        truncated: true,
        totalIncluded: counter.count,
        reason: truncationReason!,
        hint: "Narrow the path, add excludePatterns, or increase maxNodes/maxOutputBytes to see more.",
      };
    } else {
      result = {
        tree: treeData,
        truncated: false,
        totalIncluded: counter.count,
      };
    }

    let text = compact ? JSON.stringify(result) : JSON.stringify(result, null, 2);

    if (maxOutputBytes !== null && Buffer.byteLength(text, 'utf8') > maxOutputBytes) {
      result.truncated = true;
      result.reason = "maxOutputBytes";
      result.hint = "Narrow the path, add excludePatterns, or increase maxNodes/maxOutputBytes to see more.";
      text = compact ? JSON.stringify(result) : JSON.stringify(result, null, 2);
      if (Buffer.byteLength(text, 'utf8') > maxOutputBytes) {
        result.tree = [];
        result.totalIncluded = 0;
        text = compact ? JSON.stringify(result) : JSON.stringify(result, null, 2);
      }
    }

    const contentBlock = { type: "text" as const, text };
    return {
      content: [contentBlock],
      structuredContent: { content: text }
    };
  }
);

server.registerTool(
  "search_files",
  {
    title: "Search Files",
    description:
      "Recursively search for files and directories matching a pattern. " +
      "The patterns should be glob-style patterns that match paths relative to the working directory. " +
      "Use pattern like '*.ext' to match files in current directory, and '**/*.ext' to match files in all subdirectories. " +
      "Returns full paths to all matching items. Great for finding files when you don't know their exact location. " +
      "Only searches within allowed directories.",
    inputSchema: {
      path: z.string(),
      pattern: z.string(),
      excludePatterns: z.array(z.string()).optional().default([])
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true }
  },
  async (args: z.infer<typeof SearchFilesArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const results = await searchFilesWithValidation(validPath, args.pattern, allowedDirectories, { excludePatterns: args.excludePatterns });
    const text = results.length > 0 ? results.join("\n") : "No matches found";
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text }
    };
  }
);

server.registerTool(
  "get_file_info",
  {
    title: "Get File Info",
    description:
      "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
      "information including size, creation time, last modified time, permissions, " +
      "and type. This tool is perfect for understanding file characteristics " +
      "without reading the actual content. Only works within allowed directories.",
    inputSchema: {
      path: z.string()
    },
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true }
  },
  async (args: z.infer<typeof GetFileInfoArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const info = await getFileStats(validPath);
    const text = Object.entries(info)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text }
    };
  }
);

server.registerTool(
  "list_allowed_directories",
  {
    title: "List Allowed Directories",
    description:
      "Returns the list of directories that this server is allowed to access. " +
      "Subdirectories within these allowed directories are also accessible. " +
      "Use this to understand which directories and their nested paths are available " +
      "before trying to access files.",
    inputSchema: {},
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true }
  },
  async () => {
    const text = `Allowed directories:\n${allowedDirectories.join('\n')}`;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text }
    };
  }
);

// Updates allowed directories based on MCP client roots
async function updateAllowedDirectoriesFromRoots(requestedRoots: Root[]) {
  const validatedRootDirs = await getValidRootDirectories(requestedRoots);
  if (validatedRootDirs.length > 0) {
    allowedDirectories = [...validatedRootDirs];
    setAllowedDirectories(allowedDirectories);
    console.error(`Updated allowed directories from MCP roots: ${validatedRootDirs.length} valid directories`);
  } else {
    console.error("No valid root directories provided by client");
  }
}

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  try {
    const response = await server.server.listRoots();
    if (response && 'roots' in response) {
      await updateAllowedDirectoriesFromRoots(response.roots);
    }
  } catch (error) {
    console.error("Failed to request roots from client:", error instanceof Error ? error.message : String(error));
  }
});

server.server.oninitialized = async () => {
  const clientCapabilities = server.server.getClientCapabilities();

  if (clientCapabilities?.roots) {
    try {
      const response = await server.server.listRoots();
      if (response && 'roots' in response) {
        await updateAllowedDirectoriesFromRoots(response.roots);
      } else {
        console.error("Client returned no roots set, keeping current settings");
      }
    } catch (error) {
      console.error("Failed to request initial roots from client:", error instanceof Error ? error.message : String(error));
    }
  } else {
    if (allowedDirectories.length > 0) {
      console.error("Client does not support MCP Roots, using allowed directories set from server args:", allowedDirectories);
    } else {
      throw new Error(`Server cannot operate: No allowed directories available. Server was started without command-line directories and client either does not support MCP roots protocol or provided empty roots. Please either: 1) Start server with directory arguments, or 2) Use a client that supports MCP roots protocol and provides valid root directories.`);
    }
  }
};

  return server;
}

// Constant-time API key comparison.
function apiKeyMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(received, 'utf-8');
  if (a.length !== b.length) {
    // Equal-length dummy compare to keep timing uniform, but length mismatch => not a match.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function extractApiKey(req: http.IncomingMessage): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  if (Array.isArray(header) && header.length > 0) {
    return header[0];
  }
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return undefined;
}

function send401(res: http.ServerResponse, message: string): void {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('WWW-Authenticate', 'Bearer realm="mcp-filesystem", error="invalid_token"');
  res.end(JSON.stringify({ error: message }));
}

// HTTP session helpers (one transport + MCP server per client session)

type HttpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

function getMcpSessionId(req: http.IncomingMessage): string | undefined {
  const header = req.headers['mcp-session-id'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  if (Array.isArray(header) && header.length > 0) {
    return header[0];
  }
  return undefined;
}

async function readHttpBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

function sendJsonRpcBadRequest(res: http.ServerResponse, message: string): void {
  res.statusCode = 400;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  }));
}

// Start server (stdio or HTTP)

async function runStdio(): Promise<void> {
  const mcpServer = createFilesystemMcpServer();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("Secure MCP Filesystem Server (read-only) running on stdio");
  if (allowedDirectories.length === 0) {
    console.error("Started without allowed directories - waiting for client to provide roots via MCP protocol");
  }
}

async function runHttp(expectedKey: string, host: string, port: number): Promise<void> {
  const sessions = new Map<string, HttpSession>();

  async function handleMcpHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = getMcpSessionId(req);
    let parsedBody: unknown;

    if (req.method === 'POST') {
      parsedBody = await readHttpBody(req);
    }

    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === 'POST' && !sessionId && parsedBody !== undefined && isInitializeRequest(parsedBody)) {
      const mcpServer = createFilesystemMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, server: mcpServer });
          console.error(`HTTP MCP session initialized: ${sid}`);
        },
      });

      transport.onerror = (err) => {
        console.error("HTTP transport error:", err instanceof Error ? err.message : String(err));
      };

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
          console.error(`HTTP MCP session closed: ${sid}`);
        }
        void mcpServer.close().catch(() => { /* ignore */ });
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      sendJsonRpcBadRequest(res, 'Invalid or missing session ID');
      return;
    }

    sendJsonRpcBadRequest(res, 'Bad Request: No valid session ID provided');
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const received = extractApiKey(req);
      if (!received) {
        send401(res, "Missing API key. Provide X-API-Key header or Authorization: Bearer <key>.");
        return;
      }
      if (!apiKeyMatches(expectedKey, received)) {
        send401(res, "Invalid API key.");
        return;
      }
      await handleMcpHttpRequest(req, res);
    } catch (err) {
      console.error("HTTP request error:", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: "Internal server error" }));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  console.error(`Secure MCP Filesystem Server (read-only) listening on http://${host}:${port}`);
  console.error(`API key authentication is required (X-API-Key or Authorization: Bearer).`);
  if (allowedDirectories.length === 0) {
    console.error("Started without allowed directories - waiting for client to provide roots via MCP protocol");
  }

  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}, shutting down HTTP server...`);
    httpServer.close();
    for (const [sid, session] of sessions) {
      try {
        await session.transport.close();
      } catch { /* ignore */ }
      try {
        await session.server.close();
      } catch { /* ignore */ }
      sessions.delete(sid);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

async function main(): Promise<void> {
  if (cli.http) {
    await runHttp(httpApiKey as string, cli.host, cli.port);
  } else {
    await runStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
