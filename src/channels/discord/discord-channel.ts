import type {
  ChannelPlugin,
  ChannelCapabilities,
  ChannelContext,
  InboundMessage,
  OutboundMessage,
  SendResult,
  InboundMessageHandler,
  MediaPayload,
  DiscordConfig,
  Logger,
} from "../../core/types.js";
import { isAllowed } from "../../security/index.js";
import {
  GatewayIntentBits,
  Routes,
  type APIMessage,
} from "discord-api-types/v10";

const DISCORD_MAX_MESSAGE = 2000;

/**
 * Discord Channel Plugin using discord-api-types + REST
 *
 * Supports: text, threads, reactions, components, media
 */
export class DiscordChannel implements ChannelPlugin<DiscordConfig> {
  readonly id = "discord" as const;
  readonly name = "Discord";
  readonly description = "Discord bot channel via Gateway + REST";
  readonly capabilities: ChannelCapabilities = {
    supportsThreads: true,
    supportsReactions: true,
    supportsEditing: true,
    supportsMedia: true,
    supportsVoice: true,
    supportsPolls: false,
    supportsComponents: true,
    maxMessageLength: DISCORD_MAX_MESSAGE,
  };

  config: DiscordConfig;
  private ws: WebSocket | null = null;
  private handlers: InboundMessageHandler[] = [];
  private logger?: Logger;
  private running = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private token: string = "";
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly GATEWAY_CONNECT_TIMEOUT_MS = 15_000;

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.logger = ctx.logger;

    // Resolve token: support env var references (e.g. "$DISCORD_TOKEN")
    this.token = resolveToken(this.config.token) ?? "";
    if (!this.token) {
      throw new Error(
        "Discord token is required. Set via config or env var (e.g. $DISCORD_TOKEN)"
      );
    }

    // Get gateway URL
    const gatewayUrl = await this.getGatewayUrl();
    await this.connectGateway(gatewayUrl);
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Shutting down");
      this.ws = null;
    }
    this.logger?.info("Discord stopped");
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const chunks = chunkText(message.content, DISCORD_MAX_MESSAGE);
      let lastMsgId = "";

      for (const chunk of chunks) {
        const body: Record<string, unknown> = {
          content: chunk,
        };

        if (message.replyToId) {
          body.message_reference = {
            message_id: message.replyToId,
          };
        }
        if (message.silent) {
          body.flags = 1 << 12; // SUPPRESS_NOTIFICATIONS
        }

        // Validate chatId format (Discord snowflake IDs are numeric)
        if (!/^\d{1,20}$/.test(message.chatId)) {
          throw new Error("Invalid Discord channel ID format");
        }

        const response = await this.apiRequest(
          "POST",
          `/channels/${message.chatId}/messages`,
          body
        );

        lastMsgId = response.id;
      }

      return { messageId: lastMsgId, success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger?.error("Discord send failed", { error });
      return { messageId: "", success: false, error };
    }
  }

  onMessage(handler: InboundMessageHandler): void {
    this.handlers.push(handler);
  }

  // --- Gateway ---

  private async getGatewayUrl(): Promise<string> {
    const data = await this.apiRequest("GET", "/gateway/bot");
    return data.url;
  }

  private async connectGateway(url: string): Promise<void> {
    // Validate gateway URL protocol
    try {
      const parsed = new URL(url);
      if (!parsed.protocol.startsWith("wss")) {
        throw new Error(`Invalid gateway protocol: ${parsed.protocol}`);
      }
    } catch (err) {
      throw new Error(`Invalid gateway URL: ${String(err)}`);
    }

    return new Promise((resolve, reject) => {
      const wsUrl = `${url}/?v=10&encoding=json`;
      this.ws = new WebSocket(wsUrl);

      // Connection timeout
      const connectTimer = setTimeout(() => {
        reject(new Error("Gateway connection timeout"));
        this.ws?.close();
      }, DiscordChannel.GATEWAY_CONNECT_TIMEOUT_MS);

      this.ws.onopen = () => {
        this.logger?.info("Discord gateway connected");
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event: any) => {
        let data: any;
        try {
          data = JSON.parse(String(event.data));
        } catch (err) {
          this.logger?.error("Failed to parse gateway message", {
            error: String(err),
          });
          return;
        }
        this.handleGatewayEvent(data);

        if (data.op === 10) {
          clearTimeout(connectTimer);
          this.startHeartbeat(data.d.heartbeat_interval);
          this.identify();
          resolve();
        }
      };

      this.ws.onerror = (event: any) => {
        clearTimeout(connectTimer);
        this.logger?.error("Discord gateway error");
        reject(new Error("Gateway connection failed"));
      };

      this.ws.onclose = (event: any) => {
        clearTimeout(connectTimer);
        this.logger?.warn(`Discord gateway closed: ${event.code}`);
        if (this.running) {
          this.reconnectAttempts++;
          if (this.reconnectAttempts > DiscordChannel.MAX_RECONNECT_ATTEMPTS) {
            this.logger?.error("Max reconnect attempts reached, stopping");
            this.running = false;
            return;
          }
          // Exponential backoff with jitter
          const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 300_000);
          const jitter = Math.random() * baseDelay * 0.1;
          const delay = baseDelay + jitter;
          this.logger?.info(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => {
            this.connectGateway(
              this.resumeGatewayUrl ?? url
            ).catch((err) =>
              this.logger?.error("Reconnect failed", {
                error: String(err),
              })
            );
          }, delay);
        }
      };
    });
  }

  private identify(): void {
    const intents =
      GatewayIntentBits.Guilds |
      GatewayIntentBits.GuildMessages |
      GatewayIntentBits.MessageContent |
      GatewayIntentBits.DirectMessages;

    this.wsSend({
      op: 2,
      d: {
        token: this.token,
        intents,
        properties: {
          os: "linux",
          browser: "claudeclaw",
          device: "claudeclaw",
        },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatInterval = setInterval(() => {
      this.wsSend({ op: 1, d: this.sequence });
    }, intervalMs);
  }

  private handleGatewayEvent(data: any): void {
    if (data.s !== null) this.sequence = data.s;

    switch (data.op) {
      case 0: // Dispatch
        this.handleDispatch(data.t, data.d);
        break;
      case 11: // Heartbeat ACK
        break;
    }
  }

  private handleDispatch(eventName: string, data: any): void {
    switch (eventName) {
      case "READY":
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        this.logger?.info(
          `Discord ready as ${data.user.username}#${data.user.discriminator}`
        );
        break;

      case "MESSAGE_CREATE":
        // Ignore bot messages
        if (data.author.bot) return;
        this.handleMessage(data);
        break;
    }
  }

  private async handleMessage(data: any): Promise<void> {
    const message: InboundMessage = {
      id: data.id,
      channel: "discord",
      senderId: data.author.id,
      senderName:
        data.author.global_name ??
        data.author.username ??
        "Unknown",
      chatId: data.channel_id,
      threadId: data.thread?.id,
      content: data.content ?? "",
      media: this.extractMedia(data),
      timestamp: new Date(data.timestamp),
      raw: data,
    };

    // Enforce access control (allowlist / group policy)
    const isDM = !data.guild_id;
    if (
      !isAllowed(
        message.senderId,
        isDM ? "dm" : "group",
        { groupPolicy: this.config.groupPolicy },
        this.logger
      )
    ) {
      this.logger?.info(
        `Access denied for ${message.senderName} (${message.senderId})`
      );
      return;
    }

    // Enforce per-guild channel and role restrictions
    if (data.guild_id && this.config.guilds) {
      const guildConfig = this.config.guilds[data.guild_id];
      if (guildConfig) {
        // Channel restriction: only allow configured channels
        if (
          guildConfig.channels &&
          guildConfig.channels.length > 0 &&
          !guildConfig.channels.includes(data.channel_id)
        ) {
          this.logger?.debug(
            `Channel ${data.channel_id} not in guild allowlist for ${data.guild_id}`
          );
          return;
        }

        // Role restriction: sender must have at least one allowed role
        if (guildConfig.roles && guildConfig.roles.length > 0) {
          const memberRoles: string[] = data.member?.roles ?? [];
          const hasRole = guildConfig.roles.some((r: string) =>
            memberRoles.includes(r)
          );
          if (!hasRole) {
            this.logger?.debug(
              `User ${message.senderId} lacks required role in guild ${data.guild_id}`
            );
            return;
          }
        }
      }
    }

    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (err) {
        this.logger?.error("Handler error", { error: String(err) });
      }
    }
  }

  private extractMedia(data: any): MediaPayload[] | undefined {
    if (!data.attachments?.length) return undefined;

    return data.attachments.map((att: any) => ({
      type: guessMediaType(att.content_type),
      url: att.url,
      filename: att.filename,
      mimeType: att.content_type,
    }));
  }

  // --- REST API ---

  private async apiRequest(
    method: string,
    path: string,
    body?: unknown
  ): Promise<any> {
    const url = `https://discord.com/api/v10${path}`;
    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Discord API ${method} ${path}: ${response.status} ${text}`
      );
    }
    return response.json();
  }

  private wsSend(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}

// --- Utilities ---

function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let bp = remaining.lastIndexOf("\n", maxLength);
    if (bp <= 0) bp = remaining.lastIndexOf(" ", maxLength);
    if (bp <= 0) bp = maxLength;
    chunks.push(remaining.slice(0, bp));
    remaining = remaining.slice(bp).trimStart();
  }
  return chunks;
}

function guessMediaType(
  contentType?: string
): MediaPayload["type"] {
  if (!contentType) return "document";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "document";
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
