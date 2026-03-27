import { readFile, writeFile, access, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ClaudeclawConfig, Logger } from "../core/types.js";

const CONFIG_DIR = join(homedir(), ".claudeclaw");
const CONFIG_FILE = "claudeclaw.json";

const DEFAULT_CONFIG: ClaudeclawConfig = {
  agents: {
    main: {
      id: "main",
      name: "Claudeclaw",
      description: "Your personal AI assistant",
      model: "sonnet",
      capabilities: {
        canSpawn: true,
        canSend: true,
        canYield: true,
        canBroadcast: false,
        maxConcurrentChildren: 5,
      },
    },
  },
  defaultAgent: "main",
  router: {
    mode: "hybrid",
    defaultAgentId: "main",
    rules: [],
  },
  channels: {},
  anthropic: {
    apiKey: "$ANTHROPIC_API_KEY",
    defaultModel: "sonnet",
    maxTokens: 4096,
  },
  workspace: {
    path: join(CONFIG_DIR, "workspace"),
    maxFileChars: 20_000,
    maxTotalChars: 150_000,
  },
  observability: {
    enabled: true,
    traceLevel: "standard",
    output: "console",
  },
};

/**
 * Load config from ~/.claudeclaw/claudeclaw.json
 */
export async function loadConfig(logger?: Logger): Promise<ClaudeclawConfig> {
  const configPath = join(CONFIG_DIR, CONFIG_FILE);

  try {
    await access(configPath);
  } catch {
    logger?.info("No config found, using defaults");
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = await readFile(configPath, "utf-8");
    const userConfig = JSON.parse(raw) as Partial<ClaudeclawConfig>;
    const merged = deepMerge(DEFAULT_CONFIG, userConfig);
    logger?.info("Config loaded", { path: configPath });
    return merged as ClaudeclawConfig;
  } catch (err) {
    logger?.warn("Config file corrupted or unreadable, using defaults", {
      error: String(err),
    });
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save config to disk
 */
export async function saveConfig(
  config: ClaudeclawConfig,
  logger?: Logger
): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const configPath = join(CONFIG_DIR, CONFIG_FILE);

  // Redact raw tokens before saving — warn if not using env var references
  const sanitized = warnRawTokens(config, logger);

  await writeFile(configPath, JSON.stringify(sanitized, null, 2), "utf-8");
  await chmod(configPath, 0o600); // Owner-only read/write
  logger?.info("Config saved", { path: configPath });
}

/**
 * Detect duplicate tokens across channel configs
 */
export function detectDuplicateTokens(
  config: ClaudeclawConfig,
  logger?: Logger
): string[] {
  const tokenMap = new Map<string, string[]>();
  const warnings: string[] = [];

  if (config.channels.telegram?.token) {
    const t = config.channels.telegram.token;
    tokenMap.set(t, [...(tokenMap.get(t) ?? []), "telegram"]);
  }
  if (config.channels.discord?.token) {
    const t = config.channels.discord.token;
    tokenMap.set(t, [...(tokenMap.get(t) ?? []), "discord"]);
  }
  if (config.anthropic?.apiKey) {
    const t = config.anthropic.apiKey;
    tokenMap.set(t, [...(tokenMap.get(t) ?? []), "anthropic"]);
  }

  for (const [token, channels] of tokenMap) {
    if (channels.length > 1 && !token.startsWith("$")) {
      const msg = `Duplicate token detected across channels: ${channels.join(", ")}`;
      warnings.push(msg);
      logger?.error(msg);
    }
  }

  return warnings;
}

/**
 * Warn if raw tokens (not env var refs) are in config
 */
function warnRawTokens(
  config: ClaudeclawConfig,
  logger?: Logger
): ClaudeclawConfig {
  if (
    config.channels.telegram?.token &&
    !config.channels.telegram.token.startsWith("$")
  ) {
    logger?.warn(
      'Telegram token is stored as raw value. Use env var reference (e.g. "$TELEGRAM_TOKEN") instead.'
    );
  }
  if (
    config.channels.discord?.token &&
    !config.channels.discord.token.startsWith("$")
  ) {
    logger?.warn(
      'Discord token is stored as raw value. Use env var reference (e.g. "$DISCORD_TOKEN") instead.'
    );
  }
  if (
    config.anthropic?.apiKey &&
    !config.anthropic.apiKey.startsWith("$")
  ) {
    logger?.warn(
      'Anthropic API key is stored as raw value. Use env var reference (e.g. "$ANTHROPIC_API_KEY") instead.'
    );
  }
  return config;
}

/**
 * Get config directory path
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/**
 * Deep merge two objects
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(target: any, source: any): any {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;

    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}
