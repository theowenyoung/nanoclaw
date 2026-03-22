import crypto, { createDecipheriv } from 'crypto';
import fs from 'fs';
import path from 'path';

import sharp from 'sharp';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, ImageAttachment, RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// WeChat API types
// ---------------------------------------------------------------------------

interface BaseInfo {
  channel_version?: string;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number; // 1=USER, 2=BOT
  message_state?: number; // 0=NEW, 1=GENERATING, 2=FINISH
  item_list?: MessageItem[];
  context_token?: string;
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

interface MessageItem {
  type?: number; // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  text_item?: { text?: string };
  image_item?: {
    media?: CDNMedia;
    thumb_media?: CDNMedia;
    /** Raw AES key as hex string */
    aeskey?: string;
    url?: string;
    mid_size?: number;
  };
  voice_item?: { media?: CDNMedia; text?: string };
  file_item?: { media?: CDNMedia; file_name?: string };
  video_item?: { media?: CDNMedia };
  ref_msg?: { title?: string; message_item?: MessageItem };
}

const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
const MessageType = { USER: 1, BOT: 2 };
const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface WeixinCredentials {
  token: string;
  baseUrl: string;
  accountId?: string;
  userId?: string;
  savedAt?: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 4000;
const MAX_IMAGE_DIMENSION = 1024;
const MAX_IMAGE_SIZE = 1 * 1024 * 1024; // 1MB

function buildBaseInfo(): BaseInfo {
  return { channel_version: 'nanoclaw-weixin-1.0.0' };
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (body) {
    headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const base = params.baseUrl.endsWith('/')
    ? params.baseUrl
    : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders(params.token, params.body);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

async function weixinGetUpdates(
  baseUrl: string,
  token: string,
  syncBuf: string,
  timeoutMs?: number,
): Promise<GetUpdatesResp> {
  const timeout = timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: syncBuf,
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs: timeout,
      label: 'getUpdates',
    });
    return JSON.parse(rawText);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: syncBuf };
    }
    throw err;
  }
}

async function weixinSendMessage(
  baseUrl: string,
  token: string,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `nanoclaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: text
          ? [{ type: MessageItemType.TEXT, text_item: { text } }]
          : undefined,
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'sendMessage',
  });
}

async function weixinSendTyping(
  baseUrl: string,
  token: string,
  userId: string,
  typingTicket: string,
  status: number,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 10_000,
    label: 'sendTyping',
  });
}

async function weixinGetConfig(
  baseUrl: string,
  token: string,
  userId: string,
  contextToken?: string,
): Promise<{ typing_ticket?: string }> {
  const rawText = await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 10_000,
    label: 'getConfig',
  });
  return JSON.parse(rawText);
}

// ---------------------------------------------------------------------------
// CDN media download & decrypt
// ---------------------------------------------------------------------------

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Parse aes_key from CDN media. Two formats seen:
 * - base64(raw 16 bytes) — images
 * - base64(hex string of 16 bytes) — file/voice/video
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))
  ) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(
    `aes_key must decode to 16 bytes or 32-char hex, got ${decoded.length}`,
  );
}

function buildCdnDownloadUrl(encryptedQueryParam: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

async function downloadAndDecryptCdn(
  encryptedQueryParam: string,
  aesKeyBase64: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64);
  const url = buildCdnDownloadUrl(encryptedQueryParam);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CDN download failed: ${res.status} ${res.statusText}`);
  }
  const encrypted = Buffer.from(await res.arrayBuffer());
  return decryptAesEcb(encrypted, key);
}

async function downloadPlainCdn(
  encryptedQueryParam: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptedQueryParam);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CDN download failed: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download a WeChat image from CDN, decrypt, resize, and store in the group's images dir.
 */
async function downloadAndStoreWeixinImage(
  item: MessageItem,
  groupFolder: string,
  msgId: string,
): Promise<ImageAttachment | null> {
  const img = item.image_item;
  if (!img?.media?.encrypt_query_param) return null;

  try {
    // Resolve AES key: prefer image_item.aeskey (hex), fallback to media.aes_key (base64)
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, 'hex').toString('base64')
      : img.media.aes_key;

    const raw = aesKeyBase64
      ? await downloadAndDecryptCdn(img.media.encrypt_query_param, aesKeyBase64)
      : await downloadPlainCdn(img.media.encrypt_query_param);

    // Resize with sharp
    let resized = await sharp(raw)
      .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer();

    if (resized.length > MAX_IMAGE_SIZE) {
      resized = await sharp(resized).jpeg({ quality: 50 }).toBuffer();
    }

    // Save to group images dir
    const groupDir = resolveGroupFolderPath(groupFolder);
    const imagesDir = path.join(groupDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    const filename = `${msgId}.jpg`;
    fs.writeFileSync(path.join(imagesDir, filename), resized);

    logger.info(
      { groupFolder, filename, size: resized.length },
      'WeChat image saved',
    );

    return { filename, mediaType: 'image/jpeg' };
  } catch (err) {
    logger.error({ err, groupFolder, msgId }, 'Failed to download WeChat image');
    return null;
  }
}

// ---------------------------------------------------------------------------
// QR Code Login
// ---------------------------------------------------------------------------

async function fetchQRCode(
  baseUrl: string,
): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL('ilink/bot/get_bot_qrcode?bot_type=3', base);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`QR code fetch failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as { qrcode: string; qrcode_img_content: string };
}

async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<{
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    base,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`QR status poll failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as {
      status: 'wait' | 'scaned' | 'confirmed' | 'expired';
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
    };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' as const };
    }
    throw err;
  }
}

async function performQRLogin(
  baseUrl: string,
): Promise<WeixinCredentials | null> {
  console.log('\n  WeChat (微信) QR Code Login');
  console.log('  ─────────────────────────────');

  const qr = await fetchQRCode(baseUrl);
  console.log(`\n  Scan this QR code with WeChat:\n`);

  // Try to render QR in terminal
  try {
    // @ts-expect-error no type declarations for qrcode-terminal
    const qrterm = await import('qrcode-terminal');
    qrterm.default.generate(qr.qrcode_img_content, { small: true });
  } catch {
    console.log(`  QR Code URL: ${qr.qrcode_img_content}`);
  }

  console.log('\n  Waiting for scan...');

  const deadline = Date.now() + 5 * 60_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, qr.qrcode);
    switch (status.status) {
      case 'wait':
        break;
      case 'scaned':
        if (!scannedPrinted) {
          console.log('  👀 Scanned! Confirm on your phone...');
          scannedPrinted = true;
        }
        break;
      case 'expired':
        console.log('  ⏳ QR code expired.');
        return null;
      case 'confirmed':
        if (!status.bot_token || !status.ilink_bot_id) {
          console.log('  ❌ Login failed: missing token or bot ID');
          return null;
        }
        console.log('  ✅ Connected to WeChat!\n');
        return {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('  ⏳ Login timed out.');
  return null;
}

// ---------------------------------------------------------------------------
// Credential storage
// ---------------------------------------------------------------------------

function credentialsPath(): string {
  return path.join(process.cwd(), 'store', 'weixin-credentials.json');
}

function syncBufPath(): string {
  return path.join(process.cwd(), 'store', 'weixin-sync-buf.txt');
}

function loadCredentials(): WeixinCredentials | null {
  try {
    if (fs.existsSync(credentialsPath())) {
      return JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8'));
    }
  } catch {
    // ignore
  }
  return null;
}

function saveCredentials(creds: WeixinCredentials): void {
  const dir = path.dirname(credentialsPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2), 'utf-8');
  try {
    fs.chmodSync(credentialsPath(), 0o600);
  } catch {
    // best-effort
  }
}

function loadSyncBuf(): string {
  try {
    if (fs.existsSync(syncBufPath())) {
      return fs.readFileSync(syncBufPath(), 'utf-8').trim();
    }
  } catch {
    // ignore
  }
  return '';
}

function saveSyncBuf(buf: string): void {
  const dir = path.dirname(syncBufPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(syncBufPath(), buf, 'utf-8');
}

// ---------------------------------------------------------------------------
// Message text extraction
// ---------------------------------------------------------------------------

function extractTextFromItems(items?: MessageItem[]): string {
  if (!items?.length) return '';
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Build quoted context
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item?.text_item?.text) {
        parts.push(ref.message_item.text_item.text);
      }
      if (parts.length) {
        return `[引用: ${parts.join(' | ')}]\n${text}`;
      }
      return text;
    }
    // Voice-to-text
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return '';
}

function getMediaPlaceholder(items?: MessageItem[]): string {
  if (!items?.length) return '';
  for (const item of items) {
    switch (item.type) {
      case MessageItemType.IMAGE:
        return '[Photo]';
      case MessageItemType.VIDEO:
        return '[Video]';
      case MessageItemType.VOICE:
        if (!item.voice_item?.text) return '[Voice message]';
        break;
      case MessageItemType.FILE:
        return `[File: ${item.file_item?.file_name || 'file'}]`;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// WeChat Channel
// ---------------------------------------------------------------------------

export class WeixinChannel implements Channel {
  name = 'weixin';

  private baseUrl: string;
  private token: string;
  private opts: ChannelOpts;
  private running = false;
  private abortController: AbortController | null = null;

  // Context tokens per user (required for reply sends)
  private contextTokens = new Map<string, string>();
  // Typing tickets per user
  private typingTickets = new Map<string, string>();

  constructor(token: string, baseUrl: string, opts: ChannelOpts) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.abortController = new AbortController();
    this.running = true;

    console.log(`\n  WeChat bot connected (${this.baseUrl})`);
    console.log(
      `  WeChat uses direct messages — register users with wx:{user_id}\n`,
    );

    // Start long-poll loop in background
    this.pollLoop().catch((err) => {
      if (!this.abortController?.signal.aborted) {
        logger.error({ err }, 'WeChat poll loop crashed');
      }
    });
  }

  private async pollLoop(): Promise<void> {
    let syncBuf = loadSyncBuf();
    let consecutiveFailures = 0;
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;

    while (this.running && !this.abortController?.signal.aborted) {
      try {
        const resp = await weixinGetUpdates(
          this.baseUrl,
          this.token,
          syncBuf,
          nextTimeoutMs,
        );

        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        // Check for API errors
        const isError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isError) {
          consecutiveFailures++;
          logger.error(
            {
              ret: resp.ret,
              errcode: resp.errcode,
              errmsg: resp.errmsg,
              failures: consecutiveFailures,
            },
            'WeChat getUpdates failed',
          );

          // Session expired (-14)
          if (resp.errcode === -14 || resp.ret === -14) {
            logger.error('WeChat session expired, pausing 5 minutes');
            await this.sleep(5 * 60_000);
            consecutiveFailures = 0;
            continue;
          }

          if (consecutiveFailures >= 3) {
            logger.error('WeChat: 3 consecutive failures, backing off 30s');
            consecutiveFailures = 0;
            await this.sleep(30_000);
          } else {
            await this.sleep(2_000);
          }
          continue;
        }

        consecutiveFailures = 0;

        // Save sync cursor
        if (resp.get_updates_buf) {
          saveSyncBuf(resp.get_updates_buf);
          syncBuf = resp.get_updates_buf;
        }

        // Process messages
        const msgs = resp.msgs ?? [];
        for (const msg of msgs) {
          await this.handleInboundMessage(msg);
        }
      } catch (err) {
        if (this.abortController?.signal.aborted) return;

        consecutiveFailures++;
        logger.error(
          { err, failures: consecutiveFailures },
          'WeChat poll error',
        );

        if (consecutiveFailures >= 3) {
          consecutiveFailures = 0;
          await this.sleep(30_000);
        } else {
          await this.sleep(2_000);
        }
      }
    }
  }

  private async handleInboundMessage(msg: WeixinMessage): Promise<void> {
    // Only process user messages (not our own bot messages)
    if (msg.message_type === MessageType.BOT) return;
    // Skip GENERATING state — wait for FINISH
    if (msg.message_state === MessageState.GENERATING) return;

    const fromUserId = msg.from_user_id ?? '';
    if (!fromUserId) return;

    const chatJid = `wx:${fromUserId}`;
    const timestamp = msg.create_time_ms
      ? new Date(msg.create_time_ms).toISOString()
      : new Date().toISOString();
    const msgId = String(msg.message_id ?? msg.seq ?? Date.now());

    // Store context token (required for replying)
    if (msg.context_token) {
      this.contextTokens.set(fromUserId, msg.context_token);
    }

    // Fetch typing ticket for this user (best-effort, cached)
    if (!this.typingTickets.has(fromUserId)) {
      this.fetchTypingTicket(fromUserId, msg.context_token).catch(() => {});
    }

    // Extract text content
    let content = extractTextFromItems(msg.item_list);

    // Add media placeholder if no text but has media
    if (!content) {
      const placeholder = getMediaPlaceholder(msg.item_list);
      if (placeholder) {
        content = placeholder;
      }
    }

    if (!content) return;

    // Handle slash commands
    if (content.startsWith('/')) {
      await this.handleCommand(content, chatJid, fromUserId, msg.context_token);
      return;
    }

    // Record chat metadata (WeChat is always direct)
    this.opts.onChatMetadata(chatJid, timestamp, fromUserId, 'weixin', false);

    // Only deliver message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered WeChat user');
      return;
    }

    // Download image if present
    let images: ImageAttachment[] | undefined;
    const imageItem = msg.item_list?.find(
      (i) =>
        i.type === MessageItemType.IMAGE &&
        i.image_item?.media?.encrypt_query_param,
    );
    if (imageItem && group) {
      const stored = await downloadAndStoreWeixinImage(
        imageItem,
        group.folder,
        msgId,
      );
      if (stored) {
        images = [stored];
      }
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: fromUserId,
      sender_name: fromUserId.split('@')[0] || fromUserId,
      content,
      timestamp,
      is_from_me: false,
      images,
    });

    logger.info(
      { chatJid, contentLen: content.length, hasImage: !!images },
      'WeChat message stored',
    );
  }

  private async handleCommand(
    text: string,
    chatJid: string,
    fromUserId: string,
    contextToken?: string,
  ): Promise<void> {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    const sendReply = async (reply: string) => {
      try {
        await weixinSendMessage(
          this.baseUrl,
          this.token,
          fromUserId,
          reply,
          contextToken || this.contextTokens.get(fromUserId),
        );
      } catch (err) {
        logger.error({ err, fromUserId }, 'Failed to send command reply');
      }
    };

    switch (cmd) {
      case '/chatid':
        await sendReply(`Chat ID: wx:${fromUserId}`);
        return;

      case '/ping':
        await sendReply(`${ASSISTANT_NAME} is online.`);
        return;

      case '/new': {
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          await sendReply('This chat is not registered.');
          return;
        }
        if (this.opts.cancelContainer) {
          const status = this.opts.getGroupStatus?.(chatJid);
          if (status?.active) {
            this.opts.cancelContainer(chatJid);
          }
        }
        this.opts.resetSession?.(group.folder);
        await sendReply(
          'Session cleared. Next message starts a fresh conversation.',
        );
        return;
      }

      case '/cancel': {
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          await sendReply('This chat is not registered.');
          return;
        }
        const status = this.opts.getGroupStatus?.(chatJid);
        if (!status?.active) {
          await sendReply('No active agent running.');
          return;
        }
        this.opts.cancelContainer?.(chatJid);
        await sendReply('Cancelling the running agent...');
        return;
      }

      case '/status': {
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          await sendReply('This chat is not registered.');
          return;
        }
        const status = this.opts.getGroupStatus?.(chatJid);
        const lines: string[] = [];
        lines.push(`Group: ${group.name}`);
        lines.push(`Folder: ${group.folder}`);
        if (status) {
          lines.push(
            `Agent: ${status.active ? (status.idleWaiting ? 'idle' : 'running') : 'stopped'}`,
          );
          if (status.containerName)
            lines.push(`Container: ${status.containerName}`);
          if (status.pendingTaskCount > 0)
            lines.push(`Queued tasks: ${status.pendingTaskCount}`);
        } else {
          lines.push('Agent: stopped');
        }
        await sendReply(lines.join('\n'));
        return;
      }

      case '/tasks': {
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          await sendReply('This chat is not registered.');
          return;
        }
        const tasks = this.opts.getTasksForGroup?.(group.folder) || [];
        if (tasks.length === 0) {
          await sendReply('No scheduled tasks.');
          return;
        }
        const lines = tasks.map((t) => {
          const statusIcon =
            t.status === 'active' ? '▶' : t.status === 'paused' ? '⏸' : '✓';
          const schedule =
            t.schedule_type === 'once'
              ? `once at ${t.schedule_value}`
              : `${t.schedule_type}: ${t.schedule_value}`;
          const prompt =
            t.prompt.length > 60 ? t.prompt.slice(0, 60) + '...' : t.prompt;
          return `${statusIcon} ${t.id}\n  ${schedule}\n  ${prompt}`;
        });
        await sendReply(lines.join('\n\n'));
        return;
      }
    }

    // Unknown command — treat as regular message (don't swallow)
    // Re-process without the command handling
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const userId = jid.replace(/^wx:/, '');
    const contextToken = this.contextTokens.get(userId);

    if (!contextToken) {
      logger.warn(
        { jid },
        'WeChat: no context token for user, message may fail',
      );
    }

    try {
      // WeChat has a ~4000 character limit per message
      if (text.length <= MAX_TEXT_LENGTH) {
        await weixinSendMessage(
          this.baseUrl,
          this.token,
          userId,
          text,
          contextToken,
        );
      } else {
        for (let i = 0; i < text.length; i += MAX_TEXT_LENGTH) {
          await weixinSendMessage(
            this.baseUrl,
            this.token,
            userId,
            text.slice(i, i + MAX_TEXT_LENGTH),
            contextToken,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'WeChat message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send WeChat message');
    }
  }

  isConnected(): boolean {
    return this.running;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wx:');
  }

  async getChatName(jid: string): Promise<string | null> {
    const userId = jid.replace(/^wx:/, '');
    // WeChat bot API doesn't expose a user info endpoint;
    // return the user ID prefix as a fallback
    return userId.split('@')[0] || null;
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    logger.info('WeChat bot stopped');
  }

  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) {
      const existing = this.typingIntervals.get(jid);
      if (existing) {
        clearInterval(existing);
        this.typingIntervals.delete(jid);
      }
      return;
    }

    if (this.typingIntervals.has(jid)) return;

    const userId = jid.replace(/^wx:/, '');
    const ticket = this.typingTickets.get(userId);
    if (!ticket) return;

    const doTyping = () => {
      weixinSendTyping(this.baseUrl, this.token, userId, ticket, 1).catch(
        (err) => {
          logger.debug({ jid, err }, 'Failed to send WeChat typing indicator');
        },
      );
    };

    doTyping();
    this.typingIntervals.set(jid, setInterval(doTyping, 5000));
  }

  private async fetchTypingTicket(
    userId: string,
    contextToken?: string,
  ): Promise<void> {
    try {
      const config = await weixinGetConfig(
        this.baseUrl,
        this.token,
        userId,
        contextToken,
      );
      if (config.typing_ticket) {
        this.typingTickets.set(userId, config.typing_ticket);
      }
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to fetch WeChat typing ticket');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerChannel('weixin', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['WEIXIN_BOT_TOKEN', 'WEIXIN_BASE_URL']);
  const token = process.env.WEIXIN_BOT_TOKEN || envVars.WEIXIN_BOT_TOKEN || '';
  const baseUrl = process.env.WEIXIN_BASE_URL || envVars.WEIXIN_BASE_URL || '';

  // Try stored credentials if no env token
  if (!token) {
    const stored = loadCredentials();
    if (stored?.token) {
      logger.info('WeChat: using stored credentials');
      return new WeixinChannel(
        stored.token,
        stored.baseUrl || DEFAULT_BASE_URL,
        opts,
      );
    }
    logger.warn('WeChat: WEIXIN_BOT_TOKEN not set and no stored credentials');
    return null;
  }

  return new WeixinChannel(token, baseUrl || DEFAULT_BASE_URL, opts);
});

// Export for QR login flow (used by setup/customize)
export { performQRLogin, saveCredentials, loadCredentials, DEFAULT_BASE_URL };
