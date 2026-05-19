import fs from 'fs/promises';
import path from 'path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import pdfParse from 'pdf-parse';
// @kenjiuno/msgreader ships a CJS bundle whose `.default` is the MsgReader class.
// TypeScript's NodeNext resolution leaves the default import as the namespace type
// (TS2351), so we re-bind the constructor through a typed shim at module load.
import * as MsgReaderModule from '@kenjiuno/msgreader';
type MsgReaderInstance = { getFileData(): unknown };
type MsgReaderCtor = new (data: ArrayBuffer | DataView) => MsgReaderInstance;
const MsgReader = (MsgReaderModule as unknown as { default: MsgReaderCtor }).default;

// Public types

export interface ExtractOptions {
  // XLSX: sheet names (string) or 0-indexed positions (number). Default: all sheets.
  sheets?: (string | number)[];
  // PDF: render at most N pages from the start. Default: all pages.
  maxPages?: number;
  // Universal cap on returned text length, in characters. 0 = unlimited. Default: 500000.
  maxChars?: number;
}

export interface ExtractResult {
  text: string;
  detectedType: DocumentKind;
  meta: Record<string, unknown>;
  truncated: boolean;
}

export type DocumentKind =
  | 'docx'
  | 'xlsx'
  | 'pdf'
  | 'msg'
  | 'txt'
  | 'csv'
  | 'md'
  | 'log'
  | 'json'
  | 'xml'
  | 'html';

const DEFAULT_MAX_CHARS = 500_000;

// Map extension -> kind. Anything not listed is rejected with a clear error.
const EXT_TO_KIND: Record<string, DocumentKind> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pdf': 'pdf',
  '.msg': 'msg',
  '.txt': 'txt',
  '.csv': 'csv',
  '.md': 'md',
  '.markdown': 'md',
  '.log': 'log',
  '.json': 'json',
  '.xml': 'xml',
  '.html': 'html',
  '.htm': 'html',
};

export function detectDocumentKind(filePath: string): DocumentKind | undefined {
  return EXT_TO_KIND[path.extname(filePath).toLowerCase()];
}

export function supportedExtensions(): string[] {
  return Object.keys(EXT_TO_KIND);
}

// Main entry point. Dispatches to the right extractor by file extension.
export async function extractDocument(
  filePath: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const kind = detectDocumentKind(filePath);
  if (!kind) {
    const ext = path.extname(filePath).toLowerCase() || '(none)';
    throw new Error(
      `Unsupported document type '${ext}'. Supported: ${supportedExtensions().join(', ')}. ` +
      `For images or audio use read_media_file; for raw bytes use read_text_file.`,
    );
  }

  let result: ExtractResult;
  switch (kind) {
    case 'docx':
      result = await extractDocx(filePath);
      break;
    case 'xlsx':
      result = await extractXlsx(filePath, options);
      break;
    case 'pdf':
      result = await extractPdf(filePath, options);
      break;
    case 'msg':
      result = await extractMsg(filePath);
      break;
    case 'txt':
    case 'csv':
    case 'md':
    case 'log':
    case 'json':
    case 'xml':
    case 'html':
      result = await extractPlainText(filePath, kind);
      break;
  }

  return capChars(result, options.maxChars);
}

// Caps the returned text and records the original length when truncated.
function capChars(r: ExtractResult, maxCharsOpt: number | undefined): ExtractResult {
  const limit = maxCharsOpt ?? DEFAULT_MAX_CHARS;
  if (limit > 0 && r.text.length > limit) {
    return {
      ...r,
      text: r.text.slice(0, limit),
      truncated: true,
      meta: { ...r.meta, originalLength: r.text.length, maxChars: limit },
    };
  }
  return r;
}

// DOCX -> plain text via mammoth.

async function extractDocx(filePath: string): Promise<ExtractResult> {
  const buffer = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  const warnings = (result.messages ?? []).map((m) => m.message).slice(0, 20);
  return {
    text: result.value,
    detectedType: 'docx',
    meta: warnings.length > 0 ? { warnings } : {},
    truncated: false,
  };
}

// XLSX -> per-sheet CSV blocks via ExcelJS.

async function extractXlsx(filePath: string, options: ExtractOptions): Promise<ExtractResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  // Build the set of sheets the caller wants. Empty filter = all sheets.
  const filterByName = new Set<string>();
  const filterByIdx = new Set<number>();
  if (options.sheets && options.sheets.length > 0) {
    for (const s of options.sheets) {
      if (typeof s === 'string') filterByName.add(s);
      else if (typeof s === 'number' && Number.isInteger(s) && s >= 0) filterByIdx.add(s);
    }
  }
  const filterActive = filterByName.size > 0 || filterByIdx.size > 0;

  const allSheetNames: string[] = [];
  const includedSheetNames: string[] = [];
  const blocks: string[] = [];

  let idx = 0;
  wb.eachSheet((sheet) => {
    allSheetNames.push(sheet.name);
    const include = !filterActive || filterByName.has(sheet.name) || filterByIdx.has(idx);
    if (include) {
      includedSheetNames.push(sheet.name);
      blocks.push(`# Sheet: ${sheet.name}\n${worksheetToCsv(sheet)}`);
    }
    idx++;
  });

  return {
    text: blocks.join('\n\n'),
    detectedType: 'xlsx',
    meta: {
      sheetNames: allSheetNames,
      includedSheets: includedSheetNames,
    },
    truncated: false,
  };
}

function worksheetToCsv(sheet: ExcelJS.Worksheet): string {
  const lines: string[] = [];
  const rowCount = sheet.rowCount;
  const colCount = sheet.columnCount;
  if (rowCount === 0 || colCount === 0) return '';

  for (let r = 1; r <= rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    let hasContent = false;
    for (let c = 1; c <= colCount; c++) {
      const text = cellToString(row.getCell(c));
      if (text.length > 0) hasContent = true;
      cells.push(csvEscape(text));
    }
    if (hasContent) lines.push(cells.join(','));
  }
  return lines.join('\n');
}

// Resolves ExcelJS cell.value (which can be string | number | boolean | Date |
// formula | hyperlink | richText | error | null) to a flat string.
function cellToString(cell: ExcelJS.Cell): string {
  return primitiveToString(cell.value) ?? objectCellToString(cell.value);
}

function primitiveToString(v: unknown): string | undefined {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString();
  return undefined;
}

function objectCellToString(v: unknown): string {
  if (typeof v !== 'object' || v === null) return safeStringify(v);
  const obj = v as Record<string, unknown>;

  if (Array.isArray(obj.richText)) {
    return (obj.richText as { text?: string }[]).map((p) => p.text ?? '').join('');
  }
  if ('formula' in obj) return formulaResultToString(obj.result);
  if (typeof obj.hyperlink === 'string') {
    return typeof obj.text === 'string' ? obj.text : obj.hyperlink;
  }
  if ('error' in obj) return safeStringify(obj.error);
  if (typeof obj.text === 'string') return obj.text;
  return safeStringify(v);
}

function formulaResultToString(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (result instanceof Date) return result.toISOString();
  if (typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
    return safeStringify((result as { error: unknown }).error);
  }
  return safeStringify(result);
}

// Stringify defensively so unexpected object shapes don't render as "[object Object]".
function safeStringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

function csvEscape(s: string): string {
  if (s.length === 0) return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

// PDF -> text via pdf-parse.

async function extractPdf(filePath: string, options: ExtractOptions): Promise<ExtractResult> {
  const data = await fs.readFile(filePath);
  const parseOpts: { max?: number } = {};
  if (typeof options.maxPages === 'number' && Number.isInteger(options.maxPages) && options.maxPages > 0) {
    parseOpts.max = options.maxPages;
  }
  const parsed = await pdfParse(data, parseOpts);
  const text = parsed.text ?? '';
  const totalPages = parsed.numpages ?? 0;
  const pagesRendered = typeof parseOpts.max === 'number'
    ? Math.min(parseOpts.max, totalPages)
    : totalPages;
  const meta: Record<string, unknown> = {
    pages: totalPages,
    pagesRendered,
    hasExtractableText: text.trim().length > 0,
  };
  if (parsed.version) meta.pdfVersion = parsed.version;
  if (parsed.info) meta.info = parsed.info;
  return {
    text,
    detectedType: 'pdf',
    meta,
    truncated: false,
  };
}

// .msg (Outlook) -> readable headers + body via @kenjiuno/msgreader.

type MsgAttachment = {
  fileName?: string;
  displayName?: string;
  contentLength?: number;
};
type MsgRecipient = {
  name?: string;
  email?: string;
  recipType?: string;
};
type MsgData = {
  subject?: string;
  senderName?: string;
  senderEmail?: string;
  recipients?: MsgRecipient[];
  body?: string;
  bodyHtml?: string;
  messageDeliveryTime?: string | Date;
  creationTime?: string | Date;
  lastModificationTime?: string | Date;
  attachments?: MsgAttachment[];
};

async function extractMsg(filePath: string): Promise<ExtractResult> {
  const buf = await fs.readFile(filePath);
  // MsgReader's constructor accepts ArrayBuffer | DataView, not Node's Buffer.
  // Slice the underlying ArrayBuffer to the exact byte range the Buffer covers.
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const reader = new MsgReader(arrayBuffer);
  const data = reader.getFileData() as MsgData;

  const recipients = data.recipients ?? [];
  const attachments = data.attachments ?? [];
  const headers = buildMsgHeaders(data, recipients);
  const body = data.body && data.body.length > 0 ? data.body : (data.bodyHtml ?? '');

  const sections: string[] = [];
  if (headers.length > 0) sections.push(headers.join('\n'));
  sections.push(body);
  if (attachments.length > 0) sections.push(buildMsgAttachmentsBlock(attachments));

  return {
    text: sections.join('\n\n').trim(),
    detectedType: 'msg',
    meta: {
      subject: data.subject ?? null,
      from: formatAddress(data.senderName, data.senderEmail) || null,
      attachments: attachments.map(attachmentName),
      recipientCount: recipients.length,
    },
    truncated: false,
  };
}

function buildMsgHeaders(data: MsgData, recipients: MsgRecipient[]): string[] {
  const toList = recipients.filter((r) => recipTypeIs(r, 'to'));
  const ccList = recipients.filter((r) => recipTypeIs(r, 'cc'));
  const bccList = recipients.filter((r) => recipTypeIs(r, 'bcc'));
  const otherList = recipients.filter(
    (r) => !recipTypeIs(r, 'to') && !recipTypeIs(r, 'cc') && !recipTypeIs(r, 'bcc'),
  );

  const headers: string[] = [];
  const sender = formatAddress(data.senderName, data.senderEmail);
  if (sender) headers.push(`From: ${sender}`);

  const primaryTo = toList.length > 0 ? toList : otherList;
  if (primaryTo.length > 0) headers.push(`To: ${primaryTo.map(formatRecipient).join(', ')}`);
  if (ccList.length > 0) headers.push(`Cc: ${ccList.map(formatRecipient).join(', ')}`);
  if (bccList.length > 0) headers.push(`Bcc: ${bccList.map(formatRecipient).join(', ')}`);

  if (data.subject) headers.push(`Subject: ${data.subject}`);
  const when = data.messageDeliveryTime ?? data.creationTime;
  if (when) headers.push(`Date: ${typeof when === 'string' ? when : when.toISOString()}`);

  return headers;
}

function buildMsgAttachmentsBlock(attachments: MsgAttachment[]): string {
  const lines = ['Attachments:'];
  for (const a of attachments) {
    const size = typeof a.contentLength === 'number' ? ` (${a.contentLength} bytes)` : '';
    lines.push(`- ${attachmentName(a)}${size}`);
  }
  return lines.join('\n');
}

function attachmentName(a: MsgAttachment): string {
  return a.fileName ?? a.displayName ?? '(unnamed)';
}

function recipTypeIs(r: MsgRecipient, kind: 'to' | 'cc' | 'bcc'): boolean {
  const t = (r.recipType ?? '').toLowerCase();
  return t === kind || t.endsWith(`/${kind}`) || t.endsWith(kind);
}

function formatRecipient(r: MsgRecipient): string {
  return formatAddress(r.name, r.email);
}

function formatAddress(name: string | undefined, email: string | undefined): string {
  if (name && email) return `${name} <${email}>`;
  if (name) return name;
  if (email) return email;
  return '';
}

// Plain text passthrough with UTF-8 BOM stripping.

async function extractPlainText(filePath: string, kind: DocumentKind): Promise<ExtractResult> {
  let text = await fs.readFile(filePath, 'utf-8');
  if (text.codePointAt(0) === 0xFEFF) text = text.slice(1);
  return { text, detectedType: kind, meta: {}, truncated: false };
}
