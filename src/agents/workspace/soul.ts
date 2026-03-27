import { readFile, writeFile, access } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SoulConfig, Logger } from "../../core/types.js";

const SOUL_FILENAME = "SOUL.md";
const MAX_SOUL_CHARS = 20_000;

export interface SoulFile {
  path: string;
  content: string;
  traits: Record<string, string>;
  boundaries: string[];
  vibe: string;
  coreTruths: string[];
  raw: string;
}

/**
 * Load and parse a SOUL.md file from workspace
 */
export async function loadSoul(
  workspacePath: string,
  logger?: Logger
): Promise<SoulFile | null> {
  const soulPath = join(workspacePath, SOUL_FILENAME);

  try {
    await access(soulPath);
  } catch {
    logger?.debug(`No SOUL.md found at ${soulPath}`);
    return null;
  }

  const raw = await readFile(soulPath, "utf-8");
  if (raw.length > MAX_SOUL_CHARS) {
    logger?.warn(
      `SOUL.md exceeds ${MAX_SOUL_CHARS} chars (${raw.length}), truncating`
    );
  }

  const content = raw.slice(0, MAX_SOUL_CHARS);
  const stripped = stripFrontMatter(content);

  return {
    path: soulPath,
    content: stripped,
    traits: parseKeyValueSection(extractSection(stripped, "Traits")),
    boundaries: extractListSection(stripped, "Boundaries"),
    vibe: extractSection(stripped, "Vibe"),
    coreTruths: extractListSection(stripped, "Core Truths"),
    raw,
  };
}

/**
 * Create a SOUL.md file in the workspace
 */
export async function writeSoul(
  workspacePath: string,
  config: SoulConfig
): Promise<string> {
  const soulPath = join(workspacePath, SOUL_FILENAME);
  await writeFile(soulPath, config.content, "utf-8");
  return soulPath;
}

/**
 * Build system prompt injection from soul
 */
export function buildSoulPromptInjection(soul: SoulFile): string {
  const lines: string[] = [];

  lines.push("## Your Soul");
  lines.push("");
  lines.push(
    "You have a SOUL.md that defines your persona and tone. " +
      "Embody its personality. Avoid stiff, generic replies; " +
      "follow its guidance unless higher-priority instructions override it."
  );
  lines.push("");
  lines.push("---");
  lines.push(soul.content);
  lines.push("---");

  return lines.join("\n");
}

/**
 * Detect if a SOUL.md is present among loaded files
 */
export function hasSoulFile(filePaths: string[]): boolean {
  return filePaths.some((fp) => {
    const name = basename(fp).toLowerCase();
    return name === "soul.md";
  });
}

/**
 * Merge dynamic traits into soul at runtime
 */
export function mergeDynamicTraits(
  soul: SoulFile,
  dynamicTraits: Record<string, string>
): SoulFile {
  return {
    ...soul,
    traits: { ...soul.traits, ...dynamicTraits },
  };
}

// --- Internal Helpers ---

function stripFrontMatter(content: string): string {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (match) {
    return content.slice(match[0].length).trim();
  }
  return content.trim();
}

function extractSection(content: string, heading: string): string {
  // Escape regex special chars in heading to prevent injection
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `## ${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,
    "i"
  );
  // Limit content to prevent ReDoS on very large files
  const bounded = content.slice(0, 50_000);
  const match = bounded.match(regex);
  return match ? match[1].trim() : "";
}

function extractListSection(content: string, heading: string): string[] {
  const section = extractSection(content, heading);
  if (!section) return [];
  return section
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function parseKeyValueSection(section: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!section) return result;

  for (let line of section.split("\n")) {
    if (line.length > 1000) line = line.slice(0, 1000);
    const match = line.match(/^[-*]?\s*\*\*(.+?)\*\*:\s*(.+)/);
    if (match) {
      result[match[1].trim()] = match[2].trim();
    } else {
      const kvMatch = line.match(/^[-*]?\s*(.+?):\s*(.+)/);
      if (kvMatch) {
        result[kvMatch[1].trim()] = kvMatch[2].trim();
      }
    }
  }
  return result;
}
