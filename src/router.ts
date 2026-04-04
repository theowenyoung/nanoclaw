import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import {
  Channel,
  DocumentAttachment,
  ImageAttachment,
  NewMessage,
} from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface FormattedMessages {
  text: string;
  images: ImageAttachment[];
  documents: DocumentAttachment[];
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  return formatMessagesWithAttachments(messages, timezone).text;
}

/** @deprecated Use formatMessagesWithAttachments */
export function formatMessagesWithImages(
  messages: NewMessage[],
  timezone: string,
): FormattedMessages {
  return formatMessagesWithAttachments(messages, timezone);
}

/**
 * Enrich messages loaded from DB with attachments by checking the filesystem.
 * Messages with [Photo] or [Document] content that have corresponding files get attachments added.
 */
export function enrichMessagesWithAttachments(
  messages: NewMessage[],
  groupFolder: string,
): NewMessage[] {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const imagesDir = path.join(groupDir, 'images');
  const docsDir = path.join(groupDir, 'documents');

  return messages.map((m) => {
    let enriched = m;

    // Enrich images
    if (!m.images && m.content.includes('[Photo]')) {
      const filename = `${m.id}.jpg`;
      const imgPath = path.join(imagesDir, filename);
      if (fs.existsSync(imgPath)) {
        enriched = {
          ...enriched,
          images: [{ filename, mediaType: 'image/jpeg' }],
        };
      }
    }

    // Enrich documents
    if (!m.documents && m.content.includes('[Document:')) {
      // Try common extensions
      const extensions = [
        '.pdf',
        '.txt',
        '.html',
        '.json',
        '.csv',
        '.md',
        '.xml',
        '.yaml',
        '.yml',
        '.js',
        '.css',
      ];
      for (const ext of extensions) {
        const filename = `${m.id}${ext}`;
        const docPath = path.join(docsDir, filename);
        if (fs.existsSync(docPath)) {
          const mimeMap: Record<string, string> = {
            '.pdf': 'application/pdf',
            '.txt': 'text/plain',
            '.html': 'text/html',
            '.json': 'application/json',
            '.csv': 'text/csv',
            '.md': 'text/markdown',
            '.xml': 'application/xml',
            '.yaml': 'text/yaml',
            '.yml': 'text/yaml',
            '.js': 'text/javascript',
            '.css': 'text/css',
          };
          enriched = {
            ...enriched,
            documents: [
              {
                filename,
                mediaType: mimeMap[ext] || 'application/octet-stream',
                originalName: filename,
              },
            ],
          };
          break;
        }
      }
    }

    return enriched;
  });
}

/** @deprecated Use enrichMessagesWithAttachments */
export function enrichMessagesWithImages(
  messages: NewMessage[],
  groupFolder: string,
): NewMessage[] {
  return enrichMessagesWithAttachments(messages, groupFolder);
}

export function formatMessagesWithAttachments(
  messages: NewMessage[],
  timezone: string,
): FormattedMessages {
  const images: ImageAttachment[] = [];
  const documents: DocumentAttachment[] = [];

  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    if (m.images) images.push(...m.images);
    if (m.documents) documents.push(...m.documents);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;
  const text = `${header}<messages>\n${lines.join('\n')}\n</messages>`;

  return { text, images, documents };
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
