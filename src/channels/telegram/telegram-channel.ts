import type {
  ChannelPlugin,
  ChannelCapabilities,
  ChannelContext,
  InboundMessage,
  OutboundMessage,
  SendResult,
  InboundMessageHandler,
  MediaPayload,
  TelegramConfig,
  Logger,
} from "../../core/types.js";
import { isAllowed } from "../../security/index.js";

const TELEGRAM_MAX_MESSAGE = 4096;
const TELEGRAM_CHUNK_SIZE = 4000;

/**
 * Telegram Channel Plugin using grammY
 *
 * Supports: polling mode, webhook mode, text, media, reactions, forums
 */
export class TelegramChannel implements ChannelPlugin<TelegramConfig> {
  readonly id = "telegram" as const;
  readonly name = "Telegram";
  readonly description = "Telegram Bot channel via grammY";
  readonly capabilities: ChannelCapabilities = {
    supportsThreads: true,
    supportsReactions: true,
    supportsEditing: true,
    supportsMedia: true,
    supportsVoice: true,
    supportsPolls: true,
    supportsComponents: true,
    maxMessageLength: TELEGRAM_MAX_MESSAGE,
  };

  config: TelegramConfig;
  private bot: any = null; // grammY Bot instance
  private handlers: InboundMessageHandler[] = [];
  private logger?: Logger;
  private running = false;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.logger = ctx.logger;

    // Resolve token: support env var references (e.g. "$TELEGRAM_TOKEN")
    const token = resolveToken(this.config.token);
    if (!token) {
      throw new Error(
        "Telegram token is required. Set via config or env var (e.g. $TELEGRAM_TOKEN)"
      );
    }

    // Dynamic import grammY to avoid bundling issues
    const { Bot } = await import("grammy");
    this.bot = new Bot(token);

    // Register message handler
    this.bot.on("message", async (grammyCtx: any) => {
      const message = this.transformInbound(grammyCtx);

      // Enforce access control (allowlist / group policy)
      const chatType = grammyCtx.message.chat.type === "private" ? "dm" : "group";
      if (
        !isAllowed(
          message.senderId,
          chatType as "dm" | "group",
          {
            allowFrom: this.config.allowFrom,
            groupPolicy: this.config.groupPolicy,
          },
          this.logger
        )
      ) {
        this.logger?.info(
          `Access denied for ${message.senderName} (${message.senderId}) in ${chatType}`
        );
        return;
      }

      // Send typing indicator and keep refreshing while processing
      const chatId = grammyCtx.message.chat.id;
      const sendTyping = () =>
        this.bot.api
          .sendChatAction(chatId, "typing")
          .catch(() => {/* ignore errors */});

      sendTyping();
      const typingInterval = setInterval(sendTyping, 4000);

      try {
        for (const handler of this.handlers) {
          try {
            await handler(message);
          } catch (err) {
            this.logger?.error("Handler error", { error: String(err) });
          }
        }
      } finally {
        clearInterval(typingInterval);
      }
    });

    // Start polling or webhook
    if (this.config.mode === "webhook" && this.config.webhook) {
      await this.bot.api.setWebhook(this.config.webhook.url, {
        secret_token: this.config.webhook.secret,
      });
      this.logger?.info(
        `Telegram webhook set: ${this.config.webhook.url}`
      );
    } else {
      this.bot.start({
        drop_pending_updates: true,
        onStart: () => {
          this.logger?.info("Telegram polling started");
        },
      });
    }

    this.running = true;
  }

  async stop(): Promise<void> {
    if (this.bot && this.running) {
      await this.bot.stop();
      this.running = false;
      this.logger?.info("Telegram stopped");
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.bot) {
      return { messageId: "", success: false, error: "Bot not started" };
    }

    try {
      // Chunk long messages
      const chunks = chunkText(message.content, TELEGRAM_CHUNK_SIZE);
      let lastMsgId = "";

      for (let i = 0; i < chunks.length; i++) {
        const options: Record<string, unknown> = {
          parse_mode: "HTML",
        };

        if (message.threadId) {
          options.message_thread_id = Number(message.threadId);
        }
        if (message.replyToId) {
          options.reply_to_message_id = Number(message.replyToId);
        }
        if (message.silent) {
          options.disable_notification = true;
        }

        const sent = await this.bot.api.sendMessage(
          message.chatId,
          chunks[i],
          options
        );
        lastMsgId = String(sent.message_id);
      }

      // Send media attachments
      if (message.media) {
        for (const media of message.media) {
          await this.sendMedia(message.chatId, media, message.threadId);
        }
      }

      return { messageId: lastMsgId, success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger?.error("Telegram send failed", { error });
      return { messageId: "", success: false, error };
    }
  }

  onMessage(handler: InboundMessageHandler): void {
    this.handlers.push(handler);
  }

  // --- Internal ---

  private transformInbound(grammyCtx: any): InboundMessage {
    const msg = grammyCtx.message;
    const media = this.extractMedia(msg);

    return {
      id: String(msg.message_id),
      channel: "telegram",
      senderId: String(msg.from?.id ?? ""),
      senderName:
        msg.from?.first_name ??
        msg.from?.username ??
        "Unknown",
      chatId: String(msg.chat.id),
      threadId: msg.message_thread_id
        ? String(msg.message_thread_id)
        : undefined,
      content: msg.text ?? msg.caption ?? "",
      media: media.length > 0 ? media : undefined,
      timestamp: new Date(msg.date * 1000),
      raw: msg,
    };
  }

  private extractMedia(msg: any): MediaPayload[] {
    const media: MediaPayload[] = [];

    if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      media.push({
        type: "image",
        url: largest.file_id,
        caption: msg.caption,
      });
    }
    if (msg.document) {
      media.push({
        type: "document",
        url: msg.document.file_id,
        filename: msg.document.file_name,
        mimeType: msg.document.mime_type,
      });
    }
    if (msg.voice) {
      media.push({
        type: "audio",
        url: msg.voice.file_id,
        mimeType: msg.voice.mime_type,
      });
    }
    if (msg.video) {
      media.push({
        type: "video",
        url: msg.video.file_id,
        mimeType: msg.video.mime_type,
      });
    }
    if (msg.sticker) {
      media.push({
        type: "sticker",
        url: msg.sticker.file_id,
      });
    }

    return media;
  }

  private async sendMedia(
    chatId: string,
    media: MediaPayload,
    threadId?: string
  ): Promise<void> {
    const options: Record<string, unknown> = {};
    if (threadId) options.message_thread_id = Number(threadId);
    if (media.caption) options.caption = media.caption;

    const source = media.url ?? media.path ?? "";

    switch (media.type) {
      case "image":
        await this.bot.api.sendPhoto(chatId, source, options);
        break;
      case "video":
        await this.bot.api.sendVideo(chatId, source, options);
        break;
      case "audio":
        await this.bot.api.sendAudio(chatId, source, options);
        break;
      case "document":
        await this.bot.api.sendDocument(chatId, source, options);
        break;
      case "sticker":
        await this.bot.api.sendSticker(chatId, source, options);
        break;
    }
  }
}

// --- Utility ---

function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to break at newline
    let breakPoint = remaining.lastIndexOf("\n", maxLength);
    if (breakPoint <= 0) {
      // Try to break at space
      breakPoint = remaining.lastIndexOf(" ", maxLength);
    }
    if (breakPoint <= 0) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

/**
 * Resolve token value: supports env var references prefixed with $
 */
function resolveToken(value: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$")) {
    const envKey = value.slice(1);
    return process.env[envKey] || undefined;
  }
  return value;
}
