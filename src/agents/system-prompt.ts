import type {
  AgentDefinition,
  BootstrapFile,
  Logger,
} from "../core/types.js";
import { loadSoul, buildSoulPromptInjection, hasSoulFile } from "./workspace/soul.js";

export type PromptMode = "full" | "minimal" | "none";

interface SystemPromptOptions {
  agent: AgentDefinition;
  bootstrapFiles: BootstrapFile[];
  mode?: PromptMode;
  channelContext?: string;
  additionalInstructions?: string[];
}

/**
 * Build the complete system prompt for an agent session
 */
export function buildAgentSystemPrompt(
  options: SystemPromptOptions
): string {
  const {
    agent,
    bootstrapFiles,
    mode = "full",
    channelContext,
    additionalInstructions,
  } = options;

  if (mode === "none") {
    return `You are ${agent.name}. ${agent.description}`;
  }

  const sections: string[] = [];

  // --- Identity ---
  sections.push(buildIdentitySection(agent, bootstrapFiles));

  // --- Soul (only in full mode) ---
  if (mode === "full") {
    const soulSection = buildSoulSection(bootstrapFiles);
    if (soulSection) {
      sections.push(soulSection);
    }
  }

  // --- Core Instructions ---
  sections.push(buildCoreInstructions(agent, bootstrapFiles, mode));

  // --- Tools ---
  const toolsSection = buildToolsSection(bootstrapFiles);
  if (toolsSection) {
    sections.push(toolsSection);
  }

  // --- User Context ---
  if (mode === "full") {
    const userSection = buildUserSection(bootstrapFiles);
    if (userSection) {
      sections.push(userSection);
    }
  }

  // --- Memory ---
  if (mode === "full") {
    const memorySection = buildMemorySection(bootstrapFiles);
    if (memorySection) {
      sections.push(memorySection);
    }
  }

  // --- Channel Context ---
  if (channelContext) {
    sections.push(`## Current Channel\n\n${channelContext}`);
  }

  // --- Additional Instructions ---
  if (additionalInstructions?.length) {
    sections.push(
      `## Additional Instructions\n\n${additionalInstructions.join("\n\n")}`
    );
  }

  return sections.filter(Boolean).join("\n\n---\n\n");
}

// --- Section Builders ---

function buildIdentitySection(
  agent: AgentDefinition,
  files: BootstrapFile[]
): string {
  const identityFile = files.find((f) => f.name === "IDENTITY.md");
  if (identityFile) {
    return `## Identity\n\n${identityFile.content}`;
  }

  return `## Identity\n\nYou are **${agent.name}**. ${agent.description}`;
}

function buildSoulSection(files: BootstrapFile[]): string | null {
  const soulFile = files.find((f) => f.name === "SOUL.md");
  if (!soulFile) return null;

  const filePaths = files.map((f) => f.path);
  if (!hasSoulFile(filePaths)) return null;

  return [
    "## Your Soul",
    "",
    "You have a SOUL.md that defines your persona and tone. " +
      "Embody its personality. Avoid stiff, generic replies; " +
      "follow its guidance unless higher-priority instructions override it.",
    "",
    "---",
    soulFile.content,
    "---",
  ].join("\n");
}

function buildCoreInstructions(
  agent: AgentDefinition,
  files: BootstrapFile[],
  mode: PromptMode
): string {
  const agentsFile = files.find((f) => f.name === "AGENTS.md");
  if (agentsFile) {
    return `## Operating Instructions\n\n${agentsFile.content}`;
  }

  // Default core instructions
  return `## Operating Instructions

### Safety
- Never dump secrets, API keys, or credentials
- Ask before running destructive commands
- Respect user privacy and data boundaries

### Communication
- Be concise and direct
- Lead with the answer, not the reasoning
- Use the tone defined in your Soul

### Session Start
1. Read your SOUL.md, USER.md, and memory files
2. Greet the user according to your personality
3. Be ready to help

### Memory
- Store important facts in MEMORY.md
- Write daily notes to memory/YYYY-MM-DD.md
- Read memory files at session start to maintain continuity`;
}

function buildToolsSection(files: BootstrapFile[]): string | null {
  const toolsFile = files.find((f) => f.name === "TOOLS.md");
  if (!toolsFile) return null;
  return `## Tool Usage\n\n${toolsFile.content}`;
}

function buildUserSection(files: BootstrapFile[]): string | null {
  const userFile = files.find((f) => f.name === "USER.md");
  if (!userFile) return null;
  return `## About Your User\n\n${userFile.content}`;
}

function buildMemorySection(files: BootstrapFile[]): string | null {
  const memoryFile = files.find((f) => f.name === "MEMORY.md");
  if (!memoryFile) return null;
  return `## Persistent Memory\n\n${memoryFile.content}`;
}

/**
 * Determine prompt mode for a session context
 */
export function resolvePromptMode(options: {
  isSubagent: boolean;
  isGroupChat: boolean;
}): PromptMode {
  if (options.isSubagent) return "minimal";
  return "full";
}
