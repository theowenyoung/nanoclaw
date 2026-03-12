/**
 * Media processing for NanoClaw
 * Downloads, resizes, and stores images and documents from messaging channels.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

// Max dimension (width or height) for resized images
const MAX_DIMENSION = 1024;
// Max file size in bytes (after resize)
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
// Max document size (10MB — Claude supports up to ~30MB base64)
const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024;

export interface StoredImage {
  /** Filename relative to the group's images directory */
  filename: string;
  /** MIME type (e.g., image/jpeg) */
  mediaType: string;
}

export interface StoredDocument {
  /** Filename relative to the group's documents directory */
  filename: string;
  /** MIME type */
  mediaType: string;
  /** Original filename from the sender */
  originalName: string;
}

/**
 * Download an image from a URL, resize it, and save to the group's images directory.
 * Returns metadata for passing to the container agent, or null on failure.
 */
export async function downloadAndStoreImage(
  imageUrl: string,
  groupFolder: string,
  messageId: string,
): Promise<StoredImage | null> {
  try {
    // Download the image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      logger.error(
        { imageUrl, status: response.status },
        'Failed to download image',
      );
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Resize with sharp — fit within MAX_DIMENSION, convert to JPEG
    const resized = await sharp(buffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Check size after resize
    if (resized.length > MAX_FILE_SIZE) {
      // Re-compress with lower quality
      const smaller = await sharp(resized).jpeg({ quality: 50 }).toBuffer();
      return saveImage(smaller, groupFolder, messageId);
    }

    return saveImage(resized, groupFolder, messageId);
  } catch (err) {
    logger.error({ err, groupFolder, messageId }, 'Failed to process image');
    return null;
  }
}

function saveImage(
  buffer: Buffer,
  groupFolder: string,
  messageId: string,
): StoredImage {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const imagesDir = path.join(groupDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const filename = `${messageId}.jpg`;
  const filePath = path.join(imagesDir, filename);
  fs.writeFileSync(filePath, buffer);

  logger.info({ groupFolder, filename, size: buffer.length }, 'Image saved');

  return { filename, mediaType: 'image/jpeg' };
}

/** MIME types that Claude supports as document content blocks */
const SUPPORTED_DOC_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'text/xml',
  'text/csv',
  'text/markdown',
  'application/x-yaml',
  'text/yaml',
]);

/**
 * Download a document from a URL and save to the group's documents directory.
 * Returns metadata for passing to the container agent, or null on failure.
 */
export async function downloadAndStoreDocument(
  docUrl: string,
  groupFolder: string,
  messageId: string,
  originalName: string,
  mimeType?: string,
): Promise<StoredDocument | null> {
  try {
    const response = await fetch(docUrl);
    if (!response.ok) {
      logger.error(
        { docUrl, status: response.status },
        'Failed to download document',
      );
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_DOCUMENT_SIZE) {
      logger.warn(
        { groupFolder, originalName, size: buffer.length },
        'Document too large, skipping',
      );
      return null;
    }

    // Determine MIME type
    const mediaType = mimeType || guessMimeType(originalName);
    if (!SUPPORTED_DOC_TYPES.has(mediaType)) {
      logger.debug(
        { groupFolder, originalName, mediaType },
        'Unsupported document type for Claude, skipping',
      );
      return null;
    }

    const groupDir = resolveGroupFolderPath(groupFolder);
    const docsDir = path.join(groupDir, 'documents');
    fs.mkdirSync(docsDir, { recursive: true });

    // Use messageId + original extension for uniqueness
    const ext = path.extname(originalName) || '.bin';
    const filename = `${messageId}${ext}`;
    const filePath = path.join(docsDir, filename);
    fs.writeFileSync(filePath, buffer);

    logger.info(
      { groupFolder, filename, originalName, size: buffer.length, mediaType },
      'Document saved',
    );

    return { filename, mediaType, originalName };
  } catch (err) {
    logger.error({ err, groupFolder, messageId }, 'Failed to process document');
    return null;
  }
}

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
  };
  return map[ext] || 'application/octet-stream';
}
