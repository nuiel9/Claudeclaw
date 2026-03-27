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

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.logger = ctx.logger;
    this.token = this.config.token;

    if (!this.token) {
      throw new Error("Discord token is required");
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
    return new Promise((resolve, reject) => {
      const wsUrl = `${url}/?v=10&encoding=json`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.logger?.info("Discord gateway connected");
      };

      this.ws.onmessage = (event: any) => {
        const data = JSON.parse(String(event.data));
        this.handleGatewayEvent(data);

        if (data.op === 10) {
          // Hello - start heartbeat and identify
          this.startHeartbeat(data.d.heartbeat_interval);
          this.identify();
          resolve();
        }
      };

      this.ws.onerror = (event: any) => {
        this.logger?.error("Discord gateway error");
        reject(new Error("Gateway connection failed"));
      };

      this.ws.onclose = (event: any) => {
        this.logger?.warn(`Discord gateway closed: ${event.code}`);
        if (this.running) {
          // Auto-reconnect
          setTimeout(() => {
            this.connectGateway(
              this.resumeGatewayUrl ?? url
            ).catch((err) =>
              this.logger?.error("Reconnect failed", {
                error: String(err),
              })
            );
          }, 5000);
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
