/**
 * Document type resolution for NanoClaw
 * Maps sender-supplied filenames/MIME types onto the content-block formats
 * Claude accepts: base64 for PDFs, inline text for everything else.
 */
import path from 'path';

/**
 * Extension → MIME type for document formats we can hand to Claude.
 * Senders (Telegram in particular) report inconsistent MIME types for text
 * formats — `.md` arrives as `text/markdown`, `text/x-markdown`, or
 * `application/octet-stream` depending on the client — so the extension is the
 * more reliable signal and takes precedence.
 */
const DOC_MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.rst': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.py': 'text/plain',
  '.rb': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.sh': 'text/plain',
  '.sql': 'text/plain',
  '.json': 'application/json',
  '.jsonl': 'text/plain',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.tsv': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
};

/** Extensions we recognise, used when reconstructing attachments from disk */
export const DOCUMENT_EXTENSIONS = Object.keys(DOC_MIME_BY_EXT);

/** Non-`text/*` MIME types that still carry plain-text payloads */
const TEXTUAL_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/x-javascript',
  'application/x-sh',
  'application/x-ndjson',
  'application/sql',
  'application/toml',
]);

/** True when a MIME type holds text we can inline as a text document block */
export function isTextualMediaType(mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return true;
  if (TEXTUAL_APPLICATION_TYPES.has(mediaType)) return true;
  return (
    mediaType.startsWith('application/') && /\+(json|xml|yaml)$/.test(mediaType)
  );
}

/**
 * Resolve the MIME type for a document, or null when we can't pass it to Claude.
 * Extension wins over the sender-reported type; the reported type is a fallback
 * for extensions we don't know.
 */
export function resolveDocumentMediaType(
  originalName: string,
  mimeType?: string,
): string | null {
  const byExt = DOC_MIME_BY_EXT[path.extname(originalName).toLowerCase()];
  if (byExt) return byExt;

  const reported = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (!reported) return null;
  if (reported === 'application/pdf') return 'application/pdf';
  if (isTextualMediaType(reported)) return reported;
  return null;
}
