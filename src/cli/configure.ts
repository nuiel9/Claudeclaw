import { confirm, select, input, password } from "@inquirer/prompts";
import { execSync } from "node:child_process";
import chalk from "chalk";
import type { ClaudeclawConfig, Logger } from "../core/types.js";

/**
 * Check if Claude Code CLI is installed and available
 */
function detectClaudeCodeCLI(): boolean {
  try {
    execSync("which claude", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Interactive configuration walkthrough
 */
export async function runConfigure(
  config: ClaudeclawConfig,
  logger: Logger
): Promise<ClaudeclawConfig> {
  console.log("");
  console.log(chalk.bold("  🐾 Claudeclaw Configuration Wizard"));
  console.log(chalk.dim("  ─".repeat(25)));
  console.log("");

  // ═══════════════════════════════════════
  // Step 1: Authentication
  // ═══════════════════════════════════════
  console.log(chalk.bold.cyan("  Step 1: Authentication"));
  console.log("");

  const hasClaudeCLI = detectClaudeCodeCLI();
  const hasEnvApiKey = !!process.env.ANTHROPIC_API_KEY;

  // Show detected auth methods
  if (hasClaudeCLI) {
    console.log(chalk.green("  ✓ Claude Code CLI detected (uses your subscription)"));
  }
  if (hasEnvApiKey) {
    console.log(chalk.green("  ✓ $ANTHROPIC_API_KEY found in environment"));
  }
  if (!hasClaudeCLI && !hasEnvApiKey) {
    console.log(chalk.yellow("  ! No existing credentials detected"));
  }
  console.log("");

  type AuthChoice = "claude-cli" | "env-api-key" | "manual-api-key";

  const authChoices: { name: string; value: AuthChoice }[] = [];
  if (hasClaudeCLI) {
    authChoices.push({
      name: "Use Claude Code CLI (uses your Claude subscription — recommended)",
      value: "claude-cli",
    });
  }
  if (hasEnvApiKey) {
    authChoices.push({
      name: "Use $ANTHROPIC_API_KEY from environment",
      value: "env-api-key",
    });
  }
  authChoices.push(
    { name: "Enter API key manually", value: "manual-api-key" }
  );

  const authMethod = await select({
    message: "How would you like to authenticate with Claude?",
    choices: authChoices,
  });

  switch (authMethod) {
    case "claude-cli":
      // No API key needed — client will use `claude -p` at runtime
      config.anthropic.apiKey = "";
      config.anthropic.authToken = undefined;
      break;
    case "env-api-key":
      config.anthropic.apiKey = "$ANTHROPIC_API_KEY";
      config.anthropic.authToken = undefined;
      break;
    case "manual-api-key": {
      const key = await password({
        message: "Anthropic API key (sk-ant-...):",
        mask: "*",
      });
      console.log("");
      console.log(
        chalk.yellow(
          "  For security, add this to your shell profile:\n" +
          `  export ANTHROPIC_API_KEY="${key}"`
        )
      );
      config.anthropic.apiKey = "$ANTHROPIC_API_KEY";
      config.anthropic.authToken = undefined;
      break;
    }
  }

  console.log("");

  // ═══════════════════════════════════════
  // Step 2: Default Model
  // ═══════════════════════════════════════
  console.log(chalk.bold.cyan("  Step 2: Default Model"));
  console.log("");

  const model = await select({
    message: "Default model for your agents?",
    choices: [
      { name: "Sonnet  — fast & capable (recommended)", value: "sonnet" },
      { name: "Opus    — most intelligent", value: "opus" },
      { name: "Haiku   — fastest & cheapest", value: "haiku" },
    ],
    default: config.anthropic.defaultModel,
  });
  config.anthropic.defaultModel = model as any;

  console.log("");

  // ═══════════════════════════════════════
  // Step 3: Streaming
  // ═══════════════════════════════════════
  const useStreaming = await confirm({
    message: "Enable streaming responses?",
    default: config.anthropic.streaming ?? false,
  });
  config.anthropic.streaming = useStreaming;

  console.log("");

  // ═══════════════════════════════════════
  // Step 4: Channels
  // ═══════════════════════════════════════
  console.log(chalk.bold.cyan("  Step 3: Channels"));
  console.log("");

  // Telegram
  const setupTelegram = await confirm({
    message: "Set up Telegram channel?",
    default: config.channels.telegram?.enabled ?? false,
  });

  if (setupTelegram) {
    const hasTelegramEnv = !!process.env.TELEGRAM_TOKEN;
    let telegramToken = "$TELEGRAM_TOKEN";

    if (hasTelegramEnv) {
      console.log(chalk.green("  ✓ $TELEGRAM_TOKEN found in environment"));
    } else {
      const tokenInput = await password({
        message: "Telegram bot token (from @BotFather):",
        mask: "*",
      });
      if (tokenInput) {
        console.log(
          chalk.yellow(
            `  Add to shell profile: export TELEGRAM_TOKEN="${tokenInput}"`
          )
        );
      }
      telegramToken = "$TELEGRAM_TOKEN";
    }

    const telegramMode = await select({
      message: "Telegram mode?",
      choices: [
        { name: "Polling — simple, good for development", value: "polling" as const },
        { name: "Webhook — production, requires public URL", value: "webhook" as const },
      ],
      default: config.channels.telegram?.mode ?? "polling",
    });

    config.channels.telegram = {
      enabled: true,
      token: telegramToken,
      mode: telegramMode,
      groupPolicy: "allowlist",
    };

    const addAllowlist = await confirm({
      message: "Restrict to specific Telegram user IDs?",
      default: true,
    });

    if (addAllowlist) {
      const ids = await input({
        message: "Allowed user IDs (comma-separated):",
      });
      if (ids.trim()) {
        config.channels.telegram.allowFrom = ids
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
      }
    } else {
      config.channels.telegram.groupPolicy = "open";
    }
  } else {
    if (config.channels.telegram) {
      config.channels.telegram.enabled = false;
    }
  }

  console.log("");

  // Discord
  const setupDiscord = await confirm({
    message: "Set up Discord channel?",
    default: config.channels.discord?.enabled ?? false,
  });

  if (setupDiscord) {
    const hasDiscordEnv = !!process.env.DISCORD_TOKEN;

    if (hasDiscordEnv) {
      console.log(chalk.green("  ✓ $DISCORD_TOKEN found in environment"));
    } else {
      const tokenInput = await password({
        message: "Discord bot token:",
        mask: "*",
      });
      if (tokenInput) {
        console.log(
          chalk.yellow(
            `  Add to shell profile: export DISCORD_TOKEN="${tokenInput}"`
          )
        );
      }
    }

    config.channels.discord = {
      enabled: true,
      token: "$DISCORD_TOKEN",
      groupPolicy: "open",
    };

    const restrictGuilds = await confirm({
      message: "Restrict to specific Discord guild (server) IDs?",
      default: false,
    });

    if (restrictGuilds) {
      const guildIds = await input({
        message: "Guild IDs (comma-separated):",
      });
      if (guildIds.trim()) {
        config.channels.discord.guilds = {};
        for (const gid of guildIds.split(",").map((g) => g.trim()).filter(Boolean)) {
          config.channels.discord.guilds[gid] = {};
        }
      }
    }
  } else {
    if (config.channels.discord) {
      config.channels.discord.enabled = false;
    }
  }

  console.log("");

  // ═══════════════════════════════════════
  // Step 5: Agent Personality
  // ═══════════════════════════════════════
  console.log(chalk.bold.cyan("  Step 4: Agent"));
  console.log("");

  const agentName = await input({
    message: "Agent name?",
    default: config.agents[config.defaultAgent]?.name ?? "Claudeclaw",
  });

  const agentDesc = await input({
    message: "Agent description?",
    default:
      config.agents[config.defaultAgent]?.description ??
      "Your personal AI assistant",
  });

  if (config.agents[config.defaultAgent]) {
    config.agents[config.defaultAgent].name = agentName;
    config.agents[config.defaultAgent].description = agentDesc;
  }

  console.log("");

  // ═══════════════════════════════════════
  // Step 6: Observability
  // ═══════════════════════════════════════
  console.log(chalk.bold.cyan("  Step 5: Observability"));
  console.log("");

  const traceLevel = await select({
    message: "Trace level?",
    choices: [
      { name: "Minimal  — errors only", value: "minimal" as const },
      { name: "Standard — normal operation logs", value: "standard" as const },
      { name: "Verbose  — everything (debug)", value: "verbose" as const },
    ],
    default: config.observability.traceLevel,
  });
  config.observability.traceLevel = traceLevel;

  console.log("");

  // ═══════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════
  console.log(chalk.bold("  Configuration Summary"));
  console.log(chalk.dim("  ─".repeat(25)));
  console.log(`  Auth:         ${authMethod === "claude-cli" ? "Claude Code CLI (subscription)" : authMethod.replace("-", " ")}`);
  console.log(`  Model:        ${model}`);
  console.log(`  Streaming:    ${useStreaming ? "yes" : "no"}`);
  console.log(`  Agent:        ${agentName}`);
  console.log(`  Telegram:     ${setupTelegram ? "enabled" : "disabled"}`);
  console.log(`  Discord:      ${setupDiscord ? "enabled" : "disabled"}`);
  console.log(`  Trace level:  ${traceLevel}`);
  console.log("");

  const confirmSave = await confirm({
    message: "Save this configuration?",
    default: true,
  });

  if (!confirmSave) {
    logger.info("Configuration cancelled — no changes saved.");
    process.exit(0);
  }

  return config;
}
