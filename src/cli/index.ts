#!/usr/bin/env node

import { Command } from "commander";
import { createLogger } from "../core/logger.js";
import { loadConfig, saveConfig, getConfigDir } from "../config/config-loader.js";
import { ClaudeclawGateway } from "../gateway.js";
import { copyFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "../../templates");

const program = new Command();

program
  .name("claudeclaw")
  .description(
    "Personal AI assistant with multi-agent orchestration, soul system, and multi-platform channels"
  )
  .version("0.1.0");

// --- Setup ---
program
  .command("setup")
  .description("Initialize Claudeclaw workspace and configuration")
  .action(async () => {
    const logger = createLogger("setup");
    logger.info("Setting up Claudeclaw...");

    const config = await loadConfig(logger);
    const workspacePath = config.workspace.path;

    // Create workspace directory
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(workspacePath, "memory"), { recursive: true });
    logger.info(`Workspace created: ${workspacePath}`);

    // Copy template files
    const templates = [
      "SOUL.md",
      "AGENTS.md",
      "IDENTITY.md",
      "USER.md",
      "TOOLS.md",
    ];

    for (const template of templates) {
      const dest = join(workspacePath, template);
      try {
        await access(dest);
        logger.info(`${template} already exists, skipping`);
      } catch {
        await copyFile(join(TEMPLATES_DIR, template), dest);
        logger.info(`${template} created`);
      }
    }

    // Save default config
    await saveConfig(config, logger);

    logger.info("Setup complete!");
    logger.info(`Config: ${getConfigDir()}/claudeclaw.json`);
    logger.info(`Workspace: ${workspacePath}`);
    logger.info("");
    logger.info("Next steps:");
    logger.info("  1. Edit SOUL.md to customize your agent's personality");
    logger.info("  2. Configure channels (Telegram/Discord) in claudeclaw.json");
    logger.info("  3. Run: claudeclaw start");
  });

// --- Start ---
program
  .command("start")
  .description("Start the Claudeclaw gateway")
  .option("--dev", "Use dev mode soul (C-3PO)")
  .option("--log-level <level>", "Log level (debug/info/warn/error)", "info")
  .action(async (options) => {
    const logger = createLogger("claudeclaw", options.logLevel);

    logger.info("Starting Claudeclaw gateway...");

    const config = await loadConfig(logger);
    const gateway = new ClaudeclawGateway(config, logger);

    // Handle shutdown
    const shutdown = async () => {
      logger.info("Shutting down...");
      await gateway.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await gateway.start();
  });

// --- Agents ---
const agentsCmd = program
  .command("agents")
  .description("Manage agents");

agentsCmd
  .command("list")
  .description("List all registered agents")
  .action(async () => {
    const config = await loadConfig();
    console.log("\nRegistered Agents:");
    console.log("─".repeat(60));
    for (const [id, agent] of Object.entries(config.agents)) {
      const isDefault = id === config.defaultAgent ? " (default)" : "";
      console.log(`  ${id}${isDefault}`);
      console.log(`    Name: ${agent.name}`);
      console.log(`    Description: ${agent.description}`);
      console.log(`    Model: ${agent.model ?? "default"}`);
      console.log("");
    }
  });

agentsCmd
  .command("add <id>")
  .description("Add a new agent")
  .option("-n, --name <name>", "Agent display name")
  .option("-d, --desc <description>", "Agent description")
  .option("-m, --model <model>", "Model to use", "sonnet")
  .action(async (id, options) => {
    const logger = createLogger("agents");
    const config = await loadConfig(logger);

    if (config.agents[id]) {
      logger.error(`Agent "${id}" already exists`);
      process.exit(1);
    }

    config.agents[id] = {
      id,
      name: options.name ?? id,
      description: options.desc ?? `Agent: ${id}`,
      model: options.model,
    };

    // Create agent workspace
    const agentWorkspace = config.workspace.path.replace(
      /\/workspace\/?$/,
      `/workspace-${id}`
    );
    await mkdir(agentWorkspace, { recursive: true });

    // Copy templates
    for (const tpl of ["SOUL.md", "AGENTS.md", "IDENTITY.md"]) {
      await copyFile(
        join(TEMPLATES_DIR, tpl),
        join(agentWorkspace, tpl)
      );
    }

    await saveConfig(config, logger);
    logger.info(`Agent "${id}" added with workspace: ${agentWorkspace}`);
  });

// --- Channels ---
const channelsCmd = program
  .command("channels")
  .description("Manage channels");

channelsCmd
  .command("list")
  .description("List configured channels")
  .action(async () => {
    const config = await loadConfig();
    console.log("\nConfigured Channels:");
    console.log("─".repeat(40));

    if (config.channels.telegram?.enabled) {
      console.log("  Telegram: enabled");
      console.log(`    Mode: ${config.channels.telegram.mode ?? "polling"}`);
    } else {
      console.log("  Telegram: disabled");
    }

    if (config.channels.discord?.enabled) {
      console.log("  Discord: enabled");
    } else {
      console.log("  Discord: disabled");
    }
    console.log("");
  });

// --- Workflow ---
program
  .command("status")
  .description("Show gateway status")
  .action(async () => {
    const config = await loadConfig();
    console.log("\nClaudeclaw Status");
    console.log("─".repeat(40));
    console.log(`  Agents: ${Object.keys(config.agents).length}`);
    console.log(`  Default agent: ${config.defaultAgent}`);
    console.log(`  Router mode: ${config.router.mode}`);

    const enabledChannels: string[] = [];
    if (config.channels.telegram?.enabled) enabledChannels.push("Telegram");
    if (config.channels.discord?.enabled) enabledChannels.push("Discord");
    console.log(
      `  Channels: ${enabledChannels.length > 0 ? enabledChannels.join(", ") : "none"}`
    );
    console.log(`  Observability: ${config.observability.enabled ? "enabled" : "disabled"}`);
    console.log("");
  });

program.parse();
