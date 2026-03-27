import { readFile, writeFile, access, mkdir } from "node:fs/promises";
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
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  logger?.info("Config saved", { path: configPath });
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
