import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { downloadAndStoreDocument, downloadAndStoreImage } from '../image.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  DocumentAttachment,
  ImageAttachment,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/**
 * Extract reply context from a Telegram message.
 * Returns a prefix string like "[Replying to Alice: original text]" or empty string.
 */
function getReplyContext(ctx: any): string {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return '';

  const replySender =
    reply.from?.first_name || reply.from?.username || 'Unknown';

  // Build a summary of the replied-to message
  let replyPreview = '';
  if (reply.text) {
    replyPreview = reply.text;
  } else if (reply.caption) {
    replyPreview = reply.caption;
  } else if (reply.photo) {
    replyPreview = '[Photo]';
  } else if (reply.video) {
    replyPreview = '[Video]';
  } else if (reply.voice) {
    replyPreview = '[Voice message]';
  } else if (reply.document) {
    replyPreview = `[Document: ${reply.document.file_name || 'file'}]`;
  } else if (reply.sticker) {
    replyPreview = `[Sticker ${reply.sticker.emoji || ''}]`;
  } else {
    replyPreview = '[message]';
  }

  // Truncate long replies
  if (replyPreview.length > 200) {
    replyPreview = replyPreview.slice(0, 200) + '...';
  }

  return `[Replying to ${replySender}: ${replyPreview}]\n`;
}

export interface TelegramChannelOpts extends ChannelOpts {}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot send
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to start a fresh conversation
    this.bot.command('new', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }
      if (!this.opts.resetSession) {
        ctx.reply('Session reset is not available.');
        return;
      }
      // Cancel active container first if running
      if (this.opts.cancelContainer) {
        const status = this.opts.getGroupStatus?.(chatJid);
        if (status?.active) {
          this.opts.cancelContainer(chatJid);
        }
      }
      this.opts.resetSession(group.folder);
      ctx.reply('Session cleared. Next message starts a fresh conversation.');
    });

    // Command to cancel the active container
    this.bot.command('cancel', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }
      const status = this.opts.getGroupStatus?.(chatJid);
      if (!status?.active) {
        ctx.reply('No active agent running.');
        return;
      }
      this.opts.cancelContainer?.(chatJid);
      ctx.reply('Cancelling the running agent...');
    });

    // Command to check bot and container status
    this.bot.command('status', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }
      const status = this.opts.getGroupStatus?.(chatJid);
      const lines: string[] = [];
      lines.push(`Group: ${group.name}`);
      lines.push(`Folder: ${group.folder}`);
      if (status) {
        lines.push(`Agent: ${status.active ? (status.idleWaiting ? 'idle' : 'running') : 'stopped'}`);
        if (status.isTaskContainer && status.runningTaskId) {
          lines.push(`Running task: ${status.runningTaskId}`);
        }
        if (status.containerName) {
          lines.push(`Container: ${status.containerName}`);
        }
        if (status.pendingTaskCount > 0) {
          lines.push(`Queued tasks: ${status.pendingTaskCount}`);
        }
      } else {
        lines.push('Agent: stopped');
      }
      ctx.reply(lines.join('\n'));
    });

    // Command to list scheduled tasks
    this.bot.command('tasks', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }
      const tasks = this.opts.getTasksForGroup?.(group.folder) || [];
      if (tasks.length === 0) {
        ctx.reply('No scheduled tasks.');
        return;
      }
      const lines = tasks.map((t) => {
        const status = t.status === 'active' ? '▶' : t.status === 'paused' ? '⏸' : '✓';
        const schedule = t.schedule_type === 'once'
          ? `once at ${t.schedule_value}`
          : `${t.schedule_type}: ${t.schedule_value}`;
        const prompt = t.prompt.length > 60 ? t.prompt.slice(0, 60) + '...' : t.prompt;
        return `${status} ${t.id}\n  ${schedule}\n  ${prompt}`;
      });
      ctx.reply(lines.join('\n\n'));
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = getReplyContext(ctx) + ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const replyCtx = getReplyContext(ctx);

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${replyCtx}${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption || '';
      const msgId = ctx.message.message_id.toString();

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      // Get the largest photo size (last in array)
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];

      const replyCtx = getReplyContext(ctx);
      let content = replyCtx + (caption ? `[Photo] ${caption}` : '[Photo]');
      let images: ImageAttachment[] | undefined;

      try {
        const file = await this.bot!.api.getFile(largest.file_id);
        if (file.file_path) {
          const imageUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const stored = await downloadAndStoreImage(
            imageUrl,
            group.folder,
            msgId,
          );
          if (stored) {
            images = [stored];
            // Prepend trigger if caption mentions the bot
            const botUsername = ctx.me?.username?.toLowerCase();
            if (botUsername && caption) {
              const entities = ctx.message.caption_entities || [];
              const isBotMentioned = entities.some((entity) => {
                if (entity.type === 'mention') {
                  const mentionText = caption
                    .substring(entity.offset, entity.offset + entity.length)
                    .toLowerCase();
                  return mentionText === `@${botUsername}`;
                }
                return false;
              });
              if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
                content = `@${ASSISTANT_NAME} ${content}`;
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, chatJid, msgId },
          'Failed to download Telegram photo',
        );
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        images,
      });

      logger.info(
        { chatJid, sender: senderName, hasImage: !!images },
        'Telegram photo message stored',
      );
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const doc = ctx.message.document;
      const originalName = doc?.file_name || 'file';
      const mimeType = doc?.mime_type;
      const msgId = ctx.message.message_id.toString();
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const replyCtx = getReplyContext(ctx);

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let documents: DocumentAttachment[] | undefined;
      try {
        const file = await this.bot!.api.getFile(doc!.file_id);
        if (file.file_path) {
          const docUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const stored = await downloadAndStoreDocument(
            docUrl,
            group.folder,
            msgId,
            originalName,
            mimeType,
          );
          if (stored) {
            documents = [stored];
          }
        }
      } catch (err) {
        logger.error(
          { err, chatJid, msgId },
          'Failed to download Telegram document',
        );
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${replyCtx}[Document: ${originalName}]${caption}`,
        timestamp,
        is_from_me: false,
        documents,
      });

      logger.info(
        { chatJid, sender: senderName, originalName, hasDoc: !!documents },
        'Telegram document stored',
      );
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => {
      const loc = ctx.message.location;
      storeNonText(ctx, `[Location: ${loc.latitude}, ${loc.longitude}]`);
    });
    this.bot.on('message:contact', (ctx) => {
      const c = ctx.message.contact;
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
      storeNonText(ctx, `[Contact: ${name}, ${c.phone_number}]`);
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Register command menu for Telegram's "/" autocomplete
    await this.bot.api.setMyCommands([
      { command: 'new', description: 'Start a fresh conversation' },
      { command: 'cancel', description: 'Stop the running agent' },
      { command: 'status', description: 'Check bot and agent status' },
      { command: 'tasks', description: 'List scheduled tasks' },
      { command: 'ping', description: 'Check if bot is online' },
      { command: 'chatid', description: 'Get this chat\'s registration ID' },
    ]);

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
