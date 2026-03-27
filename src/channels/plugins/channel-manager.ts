import type {
  ChannelPlugin,
  ChannelContext,
  InboundMessage,
  ChatChannelId,
  ClaudeclawConfig,
  Logger,
  SessionStore,
} from "../../core/types.js";
import { TelegramChannel } from "../telegram/telegram-channel.js";
import { DiscordChannel } from "../discord/discord-channel.js";

/**
 * Channel Manager (Gateway)
 * Manages lifecycle of all channel plugins, routes inbound messages
 */
export class ChannelManager {
  private channels = new Map<ChatChannelId, ChannelPlugin>();
  private messageHandler?: (message: InboundMessage) => Promise<void>;
  private logger: Logger;
  private sessionStore: SessionStore;

  constructor(logger: Logger, sessionStore: SessionStore) {
    this.logger = logger;
    this.sessionStore = sessionStore;
  }

  /**
   * Initialize channels from config
   */
  async initialize(config: ClaudeclawConfig): Promise<void> {
    // Telegram
    if (config.channels.telegram?.enabled) {
      const telegram = new TelegramChannel(config.channels.telegram);
      this.channels.set("telegram", telegram);
      this.logger.info("Telegram channel registered");
    }

    // Discord
    if (config.channels.discord?.enabled) {
      const discord = new DiscordChannel(config.channels.discord);
      this.channels.set("discord", discord);
      this.logger.info("Discord channel registered");
    }
  }

  /**
   * Start all registered channels
   */
  async startAll(defaultAgentId: string): Promise<void> {
    for (const [id, channel] of this.channels) {
      try {
        const ctx: ChannelContext = {
          agentId: defaultAgentId,
          config: channel.config as Record<string, unknown>,
          logger: this.logger,
          sessionStore: this.sessionStore,
        };

        // Register inbound handler
        channel.onMessage(async (message) => {
          this.logger.info(
            `[${id}] Message from ${message.senderName}: ${message.content.slice(0, 100)}`
          );
          if (this.messageHandler) {
            await this.messageHandler(message);
          }
        });

        await channel.start(ctx);
        this.logger.info(`Channel started: ${id}`);
      } catch (err) {
        this.logger.error(`Failed to start channel: ${id}`, {
          error: String(err),
        });
      }
    }
  }

  /**
   * Stop all channels
   */
  async stopAll(): Promise<void> {
    for (const [id, channel] of this.channels) {
      try {
        await channel.stop();
        this.logger.info(`Channel stopped: ${id}`);
      } catch (err) {
        this.logger.error(`Failed to stop channel: ${id}`, {
          error: String(err),
        });
      }
    }
  }

  /**
   * Set the global inbound message handler
   */
  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Get a specific channel plugin
   */
  getChannel(id: ChatChannelId): ChannelPlugin | undefined {
    return this.channels.get(id);
  }

  /**
   * List active channels
   */
  listChannels(): ChatChannelId[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Send a message through a specific channel
   */
  async send(
    channelId: ChatChannelId,
    message: {
      chatId: string;
      content: string;
      threadId?: string;
      replyToId?: string;
    }
  ) {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }
    return channel.send(message);
  }
}
