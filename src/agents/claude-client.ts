import Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicConfig,
  ModelId,
  Session,
  Logger,
} from "../core/types.js";

/**
 * Model ID mapping: short name → Anthropic model identifier
 */
const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

function resolveModelId(model: ModelId): string {
  return MODEL_MAP[model] ?? model;
}

/**
 * Resolve API key: supports env var references prefixed with $
 */
function resolveApiKey(value: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$")) {
    const envKey = value.slice(1);
    return process.env[envKey] || undefined;
  }
  return value;
}

export interface ClaudeRequestOptions {
  /** Agent model override (e.g. "opus", "sonnet", "haiku") */
  model?: ModelId;
  /** System prompt for this request */
  systemPrompt?: string;
  /** Max tokens override */
  maxTokens?: number;
  /** Temperature override */
  temperature?: number;
}

export interface ClaudeResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

/**
 * Claude API Client
 *
 * Wraps @anthropic-ai/sdk with Claudeclaw-specific features:
 * - Session history → Claude messages format conversion
 * - Model short name resolution (opus/sonnet/haiku)
 * - Env var API key resolution
 * - Streaming support
 * - Error handling with structured results
 */
export class ClaudeClient {
  private client: Anthropic;
  private config: AnthropicConfig;
  private logger: Logger;

  constructor(config: AnthropicConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    const apiKey = resolveApiKey(config.apiKey);
    if (!apiKey) {
      throw new Error(
        "Anthropic API key is required. Set via config or env var (e.g. $ANTHROPIC_API_KEY)"
      );
    }

    this.client = new Anthropic({
      apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      timeout: config.timeoutMs ?? 120_000,
    });

    this.logger.info("Claude client initialized", {
      defaultModel: config.defaultModel,
      streaming: config.streaming ?? false,
    });
  }

  /**
   * Send a message and get a response (non-streaming)
   */
  async sendMessage(
    session: Session,
    userMessage: string,
    options: ClaudeRequestOptions = {}
  ): Promise<ClaudeResponse> {
    const model = resolveModelId(
      options.model ?? this.config.defaultModel
    );
    const maxTokens = options.maxTokens ?? this.config.maxTokens;
    const temperature = options.temperature ?? this.config.temperature;

    // Convert session history to Claude messages format
    const messages = this.buildMessages(session, userMessage);

    this.logger.debug("Sending Claude request", {
      model,
      messageCount: messages.length,
      maxTokens,
    });

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        messages,
        ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      });

      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n\n");

      const result: ClaudeResponse = {
        content,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason: response.stop_reason,
      };

      this.logger.debug("Claude response received", {
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        stopReason: result.stopReason,
      });

      return result;
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        this.logger.error("Claude API error", {
          status: err.status,
          message: err.message,
        });
        throw new Error(`Claude API error (${err.status}): ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Send a message and stream the response
   */
  async streamMessage(
    session: Session,
    userMessage: string,
    options: ClaudeRequestOptions = {},
    onChunk: (text: string) => void
  ): Promise<ClaudeResponse> {
    const model = resolveModelId(
      options.model ?? this.config.defaultModel
    );
    const maxTokens = options.maxTokens ?? this.config.maxTokens;
    const temperature = options.temperature ?? this.config.temperature;

    const messages = this.buildMessages(session, userMessage);

    this.logger.debug("Streaming Claude request", {
      model,
      messageCount: messages.length,
    });

    try {
      const stream = this.client.messages.stream({
        model,
        max_tokens: maxTokens,
        messages,
        ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      });

      const chunks: string[] = [];

      stream.on("text", (text) => {
        chunks.push(text);
        onChunk(text);
      });

      const finalMessage = await stream.finalMessage();

      const content = chunks.join("");
      const result: ClaudeResponse = {
        content,
        model: finalMessage.model,
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        stopReason: finalMessage.stop_reason,
      };

      this.logger.debug("Claude stream completed", {
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });

      return result;
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        this.logger.error("Claude API stream error", {
          status: err.status,
          message: err.message,
        });
        throw new Error(`Claude API error (${err.status}): ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Convert session history + new user message to Claude messages format
   */
  private buildMessages(
    session: Session,
    userMessage: string
  ): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];

    // Add session history (skip system messages, keep user/assistant)
    for (const msg of session.history) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    // Add the new user message
    messages.push({
      role: "user",
      content: userMessage,
    });

    return messages;
  }

  /**
   * Check if the client is properly configured and can reach the API
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.messages.create({
        model: resolveModelId(this.config.defaultModel),
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }],
      });
      return response.content.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get resolved model name for an agent
   */
  resolveModel(agentModel?: ModelId): string {
    return resolveModelId(agentModel ?? this.config.defaultModel);
  }
}
