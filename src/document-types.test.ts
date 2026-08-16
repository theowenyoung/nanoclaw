import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_EXTENSIONS,
  isTextualMediaType,
  resolveDocumentMediaType,
} from './document-types.js';

describe('resolveDocumentMediaType', () => {
  it('resolves by extension', () => {
    expect(resolveDocumentMediaType('notes.md')).toBe('text/markdown');
    expect(resolveDocumentMediaType('report.pdf')).toBe('application/pdf');
    expect(resolveDocumentMediaType('data.csv')).toBe('text/csv');
    expect(resolveDocumentMediaType('config.yml')).toBe('text/yaml');
  });

  it('prefers the extension over a generic sender MIME type', () => {
    // Telegram reports .md files as application/octet-stream on some clients
    expect(
      resolveDocumentMediaType('notes.md', 'application/octet-stream'),
    ).toBe('text/markdown');
    expect(resolveDocumentMediaType('notes.md', 'text/x-markdown')).toBe(
      'text/markdown',
    );
  });

  it('falls back to the sender MIME type for unknown extensions', () => {
    expect(resolveDocumentMediaType('notes.unknown', 'text/plain')).toBe(
      'text/plain',
    );
    expect(resolveDocumentMediaType('scan', 'application/pdf')).toBe(
      'application/pdf',
    );
    expect(
      resolveDocumentMediaType(
        'feed.atom',
        'application/atom+xml; charset=utf-8',
      ),
    ).toBe('application/atom+xml');
  });

  it('rejects types Claude cannot read', () => {
    expect(
      resolveDocumentMediaType('archive.zip', 'application/zip'),
    ).toBeNull();
    expect(resolveDocumentMediaType('clip.mp4', 'video/mp4')).toBeNull();
    expect(
      resolveDocumentMediaType('blob', 'application/octet-stream'),
    ).toBeNull();
    expect(resolveDocumentMediaType('blob')).toBeNull();
  });

  it('is case-insensitive on the extension', () => {
    expect(resolveDocumentMediaType('README.MD')).toBe('text/markdown');
  });

  it('resolves every advertised extension', () => {
    for (const ext of DOCUMENT_EXTENSIONS) {
      expect(resolveDocumentMediaType(`file${ext}`)).toBeTruthy();
    }
  });
});

describe('isTextualMediaType', () => {
  it('accepts text and text-bearing application types', () => {
    expect(isTextualMediaType('text/markdown')).toBe(true);
    expect(isTextualMediaType('application/json')).toBe(true);
    expect(isTextualMediaType('application/x-yaml')).toBe(true);
    expect(isTextualMediaType('application/ld+json')).toBe(true);
  });

  it('rejects binary types, including PDF', () => {
    // PDFs are readable, but as a base64 document source — not inline text
    expect(isTextualMediaType('application/pdf')).toBe(false);
    expect(isTextualMediaType('application/zip')).toBe(false);
    expect(isTextualMediaType('image/png')).toBe(false);
  });
});
