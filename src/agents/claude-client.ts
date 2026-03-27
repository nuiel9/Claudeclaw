import Anthropic from "@anthropic-ai/sdk";
import { execSync, spawn } from "node:child_process";
import { userInfo } from "node:os";
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
 * Resolve a config value: supports env var references prefixed with $
 */
function resolveValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$")) {
    const envKey = value.slice(1);
    return process.env[envKey] || undefined;
  }
  return value;
}

/**
 * Check if Claude Code CLI is available and authenticated
 */
function detectClaudeCodeCLI(): boolean {
  try {
    execSync("which claude", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
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

type AuthMode = "api-key" | "claude-cli";

/**
 * Claude API Client
 *
 * Supports two authentication modes:
 * 1. Direct API — uses @anthropic-ai/sdk with API key
 * 2. Claude CLI — pipes requests through `claude -p` (uses your Claude subscription OAuth)
 */
export class ClaudeClient {
  private client: Anthropic | null = null;
  private config: AnthropicConfig;
  private logger: Logger;
  private authMode: AuthMode;

  constructor(config: AnthropicConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    const apiKey = resolveValue(config.apiKey);

    // Determine auth mode: API key if available, otherwise Claude CLI
    if (apiKey) {
      this.authMode = "api-key";
      this.client = new Anthropic({
        apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
        timeout: config.timeoutMs ?? 120_000,
      });
    } else if (detectClaudeCodeCLI()) {
      this.authMode = "claude-cli";
    } else {
      throw new Error(
        "No auth method available. Either set anthropic.apiKey / $ANTHROPIC_API_KEY, " +
        "or install Claude Code CLI (claude login) to use your subscription."
      );
    }

    this.logger.info("Claude client initialized", {
      defaultModel: config.defaultModel,
      streaming: config.streaming ?? false,
      authMethod: this.authMode,
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
    if (this.authMode === "claude-cli") {
      return this.sendViaCLI(session, userMessage, options);
    }
    return this.sendViaAPI(session, userMessage, options);
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
    if (this.authMode === "claude-cli") {
      // CLI mode doesn't support true streaming to callback, but we get the full result
      const result = await this.sendViaCLI(session, userMessage, options);
      onChunk(result.content);
      return result;
    }
    return this.streamViaAPI(session, userMessage, options, onChunk);
  }

  // ═══════════════════════════════════════
  // Claude CLI Backend
  // ═══════════════════════════════════════

  private async sendViaCLI(
    session: Session,
    userMessage: string,
    options: ClaudeRequestOptions = {}
  ): Promise<ClaudeResponse> {
    const model = options.model ?? this.config.defaultModel;

    // Build the prompt: include system prompt + conversation history context
    let prompt = "";

    if (options.systemPrompt) {
      prompt += `[System Instructions]\n${options.systemPrompt}\n\n`;
    }

    // Include recent session history for context
    const recentHistory = session.history.slice(-20); // Last 20 messages
    if (recentHistory.length > 0) {
      prompt += "[Conversation History]\n";
      for (const msg of recentHistory) {
        if (msg.role === "user" || msg.role === "assistant") {
          const label = msg.role === "user" ? "User" : "Assistant";
          prompt += `${label}: ${msg.content}\n`;
        }
      }
      prompt += "\n";
    }

    prompt += `[Current Message]\nUser: ${userMessage}`;

    this.logger.debug("Sending via Claude CLI", {
      model,
      promptLength: prompt.length,
    });

    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", resolveModelId(model),
      "--no-session-persistence",
    ];

    // Add system prompt via --append-system-prompt for cleaner handling
    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
      // Remove system prompt from the main prompt since we're passing it separately
      prompt = "";
      if (recentHistory.length > 0) {
        prompt += "[Conversation History]\n";
        for (const msg of recentHistory) {
          if (msg.role === "user" || msg.role === "assistant") {
            const label = msg.role === "user" ? "Assistant" : "User";
            prompt += `${label}: ${msg.content}\n`;
          }
        }
        prompt += "\n";
      }
      prompt += userMessage;
      args[1] = prompt;
    }

    return new Promise<ClaudeResponse>((resolve, reject) => {
      const proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        timeout: this.config.timeoutMs ?? 120_000,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          this.logger.error("Claude CLI error", { code, stderr });
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          const result: ClaudeResponse = {
            content: parsed.result ?? "",
            model: Object.keys(parsed.modelUsage ?? {})[0] ?? resolveModelId(model),
            inputTokens: parsed.usage?.input_tokens ?? 0,
            outputTokens: parsed.usage?.output_tokens ?? 0,
            stopReason: parsed.stop_reason ?? "end_turn",
          };

          this.logger.debug("Claude CLI response received", {
            model: result.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            durationMs: parsed.duration_ms,
          });

          resolve(result);
        } catch (err) {
          this.logger.error("Failed to parse Claude CLI response", {
            stdout: stdout.slice(0, 500),
          });
          reject(new Error(`Failed to parse Claude CLI response: ${err}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
      });
    });
  }

  // ═══════════════════════════════════════
  // Direct API Backend
  // ═══════════════════════════════════════

  private async sendViaAPI(
    session: Session,
    userMessage: string,
    options: ClaudeRequestOptions = {}
  ): Promise<ClaudeResponse> {
    const model = resolveModelId(
      options.model ?? this.config.defaultModel
    );
    const maxTokens = options.maxTokens ?? this.config.maxTokens;
    const temperature = options.temperature ?? this.config.temperature;
    const messages = this.buildMessages(session, userMessage);

    this.logger.debug("Sending Claude API request", {
      model,
      messageCount: messages.length,
      maxTokens,
    });

    try {
      const response = await this.client!.messages.create({
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

      this.logger.debug("Claude API response received", {
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

  private async streamViaAPI(
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

    this.logger.debug("Streaming Claude API request", {
      model,
      messageCount: messages.length,
    });

    try {
      const stream = this.client!.messages.stream({
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

      this.logger.debug("Claude API stream completed", {
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

    for (const msg of session.history) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

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
      if (this.authMode === "claude-cli") {
        const result = execSync('claude -p "ping" --output-format json', {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15_000,
        });
        const parsed = JSON.parse(result);
        return !!parsed.result;
      }

      const response = await this.client!.messages.create({
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

  /**
   * Get current auth mode
   */
  getAuthMode(): AuthMode {
    return this.authMode;
  }
}
