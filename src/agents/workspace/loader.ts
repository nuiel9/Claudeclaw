import { readFile, readdir, stat, access, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type {
  BootstrapFile,
  BootstrapFileName,
  WorkspaceConfig,
  Logger,
  DEFAULT_WORKSPACE_CONFIG,
} from "../../core/types.js";

const BOOTSTRAP_FILES: BootstrapFileName[] = [
  "SOUL.md",
  "AGENTS.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
];

const SUBAGENT_ALLOWED_FILES: BootstrapFileName[] = [
  "AGENTS.md",
  "TOOLS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
];

interface FileCache {
  path: string;
  content: string;
  ino: number;
  size: number;
  mtimeMs: number;
}

const fileCache = new Map<string, FileCache>();

/**
 * Resolve workspace path with ~ expansion
 */
export function resolveWorkspacePath(
  configPath: string,
  agentId?: string
): string {
  let base = configPath.replace(/^~/, homedir());
  if (agentId && agentId !== "main") {
    base = base.replace(/\/workspace\/?$/, `/workspace-${agentId}`);
  }
  return base;
}

/**
 * Ensure workspace directory exists
 */
export async function ensureWorkspace(workspacePath: string): Promise<void> {
  try {
    await access(workspacePath);
  } catch {
    await mkdir(workspacePath, { recursive: true });
  }
}

/**
 * Load all bootstrap files from workspace
 */
export async function loadBootstrapFiles(
  workspacePath: string,
  options: {
    maxFileChars?: number;
    maxTotalChars?: number;
    isSubagent?: boolean;
    logger?: Logger;
  } = {}
): Promise<BootstrapFile[]> {
  const {
    maxFileChars = 20_000,
    maxTotalChars = 150_000,
    isSubagent = false,
    logger,
  } = options;

  const allowedFiles = isSubagent ? SUBAGENT_ALLOWED_FILES : BOOTSTRAP_FILES;
  const files: BootstrapFile[] = [];
  let totalChars = 0;

  for (const fileName of allowedFiles) {
    const filePath = join(workspacePath, fileName);

    try {
      await access(filePath);
    } catch {
      continue;
    }

    const fileStat = await stat(filePath);
    const cached = fileCache.get(filePath);

    let content: string;
    if (
      cached &&
      cached.ino === fileStat.ino &&
      cached.size === fileStat.size &&
      cached.mtimeMs === fileStat.mtimeMs
    ) {
      content = cached.content;
      logger?.debug(`Cache hit for ${fileName}`);
    } else {
      content = await readFile(filePath, "utf-8");
      content = stripFrontMatter(content);

      fileCache.set(filePath, {
        path: filePath,
        content,
        ino: fileStat.ino,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      });
      logger?.debug(`Loaded ${fileName} (${content.length} chars)`);
    }

    if (content.length > maxFileChars) {
      logger?.warn(
        `${fileName} exceeds ${maxFileChars} chars, truncating`
      );
      content = content.slice(0, maxFileChars);
    }

    if (totalChars + content.length > maxTotalChars) {
      logger?.warn(
        `Total bootstrap chars would exceed ${maxTotalChars}, stopping`
      );
      break;
    }

    totalChars += content.length;
    files.push({
      name: fileName,
      path: filePath,
      content,
      size: content.length,
      lastModified: fileStat.mtime,
    });
  }

  logger?.info(`Loaded ${files.length} bootstrap files (${totalChars} chars)`);
  return files;
}

/**
 * Load a specific bootstrap file
 */
export async function loadBootstrapFile(
  workspacePath: string,
  fileName: BootstrapFileName
): Promise<BootstrapFile | null> {
  const filePath = join(workspacePath, fileName);
  try {
    const content = await readFile(filePath, "utf-8");
    const fileStat = await stat(filePath);
    return {
      name: fileName,
      path: filePath,
      content: stripFrontMatter(content),
      size: content.length,
      lastModified: fileStat.mtime,
    };
  } catch {
    return null;
  }
}

/**
 * List all files in workspace
 */
export async function listWorkspaceFiles(
  workspacePath: string
): Promise<string[]> {
  try {
    const entries = await readdir(workspacePath);
    return entries.map((e) => join(workspacePath, e));
  } catch {
    return [];
  }
}

/**
 * Clear the file cache
 */
export function clearFileCache(): void {
  fileCache.clear();
}

// --- Internal ---

function stripFrontMatter(content: string): string {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (match) {
    return content.slice(match[0].length).trim();
  }
  return content.trim();
}
