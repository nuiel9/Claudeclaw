import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Session, SessionStore, SessionMessage, Logger } from "../core/types.js";
import { v4 as uuid } from "uuid";

/**
 * In-memory session store with optional JSONL persistence
 */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  async get(key: string): Promise<Session | undefined> {
    return this.sessions.get(key);
  }

  async set(key: string, session: Session): Promise<void> {
    this.sessions.set(key, session);
  }

  async delete(key: string): Promise<void> {
    this.sessions.delete(key);
  }

  async list(prefix?: string): Promise<Session[]> {
    const all = Array.from(this.sessions.values());
    if (!prefix) return all;
    return all.filter((s) => s.key.startsWith(prefix));
  }
}

/**
 * File-backed session store using JSONL transcripts
 */
export class FileSessionStore implements SessionStore {
  private cache = new Map<string, Session>();
  private logger?: Logger;
  private basePath: string;

  constructor(basePath: string, logger?: Logger) {
    this.basePath = basePath;
    this.logger = logger;
  }

  async get(key: string): Promise<Session | undefined> {
    if (this.cache.has(key)) return this.cache.get(key);

    try {
      const filePath = this.sessionPath(key);
      const data = await readFile(filePath, "utf-8");
      const session = JSON.parse(data) as Session;
      session.createdAt = new Date(session.createdAt);
      session.lastActiveAt = new Date(session.lastActiveAt);
      this.cache.set(key, session);
      return session;
    } catch {
      return undefined;
    }
  }

  async set(key: string, session: Session): Promise<void> {
    this.cache.set(key, session);
    await mkdir(this.basePath, { recursive: true });
    const filePath = this.sessionPath(key);
    await writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    try {
      await unlink(this.sessionPath(key));
    } catch {
      // file may not exist
    }
  }

  async list(prefix?: string): Promise<Session[]> {
    try {
      const files = await readdir(this.basePath);
      const sessions: Session[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const key = file.replace(".json", "");
        if (prefix && !key.startsWith(prefix)) continue;
        const session = await this.get(key);
        if (session) sessions.push(session);
      }
      return sessions;
    } catch {
      return [];
    }
  }

  private sessionPath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.basePath, `${safeKey}.json`);
  }
}

/**
 * Create a new session
 */
export function createSession(
  agentId: string,
  key: string,
  channelId?: string,
  peerId?: string
): Session {
  return {
    id: uuid(),
    agentId,
    key,
    channelId,
    peerId,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    metadata: {},
    history: [],
  };
}

/**
 * Build a session key from components
 */
export function buildSessionKey(parts: {
  agentId: string;
  channel?: string;
  chatId?: string;
  peerId?: string;
  scope?: "main" | "per-peer" | "per-channel-peer";
}): string {
  const { agentId, channel, chatId, peerId, scope = "main" } = parts;
  const segments = [`agent:${agentId}`];

  if (channel && chatId) {
    segments.push(`${channel}:${chatId}`);
  }

  if (scope === "per-peer" && peerId) {
    segments.push(`peer:${peerId}`);
  } else if (scope === "per-channel-peer" && channel && peerId) {
    segments.push(`peer:${peerId}`);
  }

  return segments.join(":");
}

/**
 * Add a message to session history
 */
export function addMessageToSession(
  session: Session,
  role: SessionMessage["role"],
  content: string,
  metadata?: Record<string, unknown>
): SessionMessage {
  const msg: SessionMessage = {
    id: uuid(),
    role,
    content,
    timestamp: new Date(),
    metadata,
  };
  session.history.push(msg);
  session.lastActiveAt = new Date();
  return msg;
}
