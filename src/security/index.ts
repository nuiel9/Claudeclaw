import type { Logger } from "../core/types.js";
import { timingSafeEqual, createHmac } from "node:crypto";

// ============================================================
// Access Control — Allowlist & Policy Enforcement
// ============================================================

export type AccessPolicy = "open" | "allowlist" | "disabled";

export interface AccessControlConfig {
  allowFrom?: string[];
  groupPolicy?: AccessPolicy;
  dmPolicy?: AccessPolicy;
}

/**
 * Check if a sender is allowed based on access policy and allowlist
 */
export function isAllowed(
  senderId: string,
  chatType: "dm" | "group",
  config: AccessControlConfig,
  logger?: Logger
): boolean {
  const policy =
    chatType === "dm"
      ? (config.dmPolicy ?? config.groupPolicy ?? "open")
      : (config.groupPolicy ?? "open");

  switch (policy) {
    case "disabled":
      logger?.debug(`Access denied (${chatType} disabled): ${senderId}`);
      return false;

    case "allowlist":
      if (!config.allowFrom || config.allowFrom.length === 0) {
        logger?.warn(
          `Allowlist policy active but no allowFrom configured — denying all`
        );
        return false;
      }
      const allowed = config.allowFrom.includes(senderId);
      if (!allowed) {
        logger?.debug(`Access denied (not in allowlist): ${senderId}`);
      }
      return allowed;

    case "open":
    default:
      return true;
  }
}

// ============================================================
// Tool Policy — Runtime Allow/Deny Enforcement
// ============================================================

export interface ToolPolicy {
  mode: "allowlist" | "denylist" | "unrestricted";
  tools: string[];
}

/**
 * Check if a tool is permitted for an agent
 */
export function isToolAllowed(
  toolName: string,
  policy: ToolPolicy
): boolean {
  switch (policy.mode) {
    case "allowlist":
      return policy.tools.includes(toolName);
    case "denylist":
      return !policy.tools.includes(toolName);
    case "unrestricted":
      return true;
  }
}

/**
 * Resolve effective tool policy from agent definition
 */
export function resolveToolPolicy(
  agentTools?: string[],
  parentTools?: string[]
): ToolPolicy {
  if (agentTools && agentTools.length > 0) {
    return { mode: "allowlist", tools: agentTools };
  }
  if (parentTools && parentTools.length > 0) {
    return { mode: "allowlist", tools: parentTools };
  }
  return { mode: "unrestricted", tools: [] };
}

// ============================================================
// Webhook Security — HMAC & Timing-Safe Verification
// ============================================================

/**
 * Verify a webhook signature using HMAC-SHA256 with timing-safe comparison
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
  algorithm: string = "sha256"
): boolean {
  try {
    const expected = createHmac(algorithm, secret)
      .update(payload)
      .digest("hex");

    const sigBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Verify Telegram webhook secret token (timing-safe string comparison)
 */
export function verifyTelegramSecret(
  receivedSecret: string,
  expectedSecret: string
): boolean {
  try {
    const a = Buffer.from(receivedSecret, "utf-8");
    const b = Buffer.from(expectedSecret, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ============================================================
// Session Write Lock — Prevent Race Conditions
// ============================================================

/**
 * Session write lock manager — ensures exclusive access per session key
 */
export class SessionWriteLock {
  private locks = new Map<string, Promise<void>>();
  private resolvers = new Map<string, () => void>();

  /**
   * Acquire exclusive lock for a session key.
   * If already locked, waits for the current holder to release.
   */
  async acquire(key: string): Promise<() => void> {
    // Wait for existing lock to be released
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Create new lock
    let releaseFn: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    this.locks.set(key, lockPromise);
    this.resolvers.set(key, releaseFn!);

    // Return release function
    return () => {
      this.locks.delete(key);
      this.resolvers.delete(key);
      releaseFn!();
    };
  }

  /**
   * Execute a function with exclusive session access
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if a session is currently locked
   */
  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  /**
   * Number of active locks
   */
  get size(): number {
    return this.locks.size;
  }
}

// ============================================================
// Exec Approval — Human-in-the-Loop for Dangerous Actions
// ============================================================

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ExecApprovalRequest {
  id: string;
  agentId: string;
  action: string;
  description: string;
  risk: "low" | "medium" | "high" | "critical";
  requestedAt: Date;
  expiresAt: Date;
  status: ApprovalStatus;
  approvedBy?: string;
  deniedReason?: string;
}

/**
 * Actions that require approval based on risk level
 */
const DANGEROUS_PATTERNS = [
  { pattern: /\brm\s+-rf\b/i, risk: "critical" as const, desc: "Recursive force delete" },
  { pattern: /\bdrop\s+table\b/i, risk: "critical" as const, desc: "Drop database table" },
  { pattern: /\bgit\s+push\s+--force\b/i, risk: "high" as const, desc: "Force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, risk: "high" as const, desc: "Hard reset" },
  { pattern: /\bsudo\b/i, risk: "high" as const, desc: "Sudo command" },
  { pattern: /\bchmod\s+777\b/i, risk: "medium" as const, desc: "World-writable permissions" },
  { pattern: /\bcurl\b.*\|\s*\bsh\b/i, risk: "critical" as const, desc: "Pipe curl to shell" },
  { pattern: /\beval\s*\(/i, risk: "high" as const, desc: "Dynamic code execution" },
];

/**
 * Exec approval manager
 */
export class ExecApprovalManager {
  private pending = new Map<string, ExecApprovalRequest>();
  private approvalHandler?: (request: ExecApprovalRequest) => Promise<boolean>;
  private logger?: Logger;
  private defaultTimeoutMs: number;

  constructor(logger?: Logger, defaultTimeoutMs: number = 300_000) {
    this.logger = logger;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Set the approval handler (e.g. send button to Telegram/Discord)
   */
  onApprovalRequired(
    handler: (request: ExecApprovalRequest) => Promise<boolean>
  ): void {
    this.approvalHandler = handler;
  }

  /**
   * Check if a command needs approval and request it if so
   */
  async checkAndApprove(
    agentId: string,
    command: string
  ): Promise<{ approved: boolean; request?: ExecApprovalRequest }> {
    const match = this.detectDangerousAction(command);
    if (!match) {
      return { approved: true };
    }

    const request: ExecApprovalRequest = {
      id: crypto.randomUUID(),
      agentId,
      action: command.slice(0, 200),
      description: match.desc,
      risk: match.risk,
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + this.defaultTimeoutMs),
      status: "pending",
    };

    this.pending.set(request.id, request);
    this.logger?.warn(
      `Exec approval required: [${match.risk}] ${match.desc}`,
      { agentId, action: command.slice(0, 100) }
    );

    if (!this.approvalHandler) {
      this.logger?.error("No approval handler set — denying by default");
      request.status = "denied";
      request.deniedReason = "No approval handler configured";
      return { approved: false, request };
    }

    try {
      const approved = await this.approvalHandler(request);
      request.status = approved ? "approved" : "denied";
      this.logger?.info(
        `Exec ${approved ? "approved" : "denied"}: ${match.desc}`
      );
      return { approved, request };
    } catch {
      request.status = "expired";
      return { approved: false, request };
    } finally {
      this.pending.delete(request.id);
    }
  }

  /**
   * Detect if a command matches dangerous patterns
   */
  private detectDangerousAction(
    command: string
  ): { risk: "low" | "medium" | "high" | "critical"; desc: string } | null {
    for (const { pattern, risk, desc } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { risk, desc };
      }
    }
    return null;
  }

  /**
   * List pending approval requests
   */
  listPending(): ExecApprovalRequest[] {
    return Array.from(this.pending.values());
  }
}

// ============================================================
// Agent Sandbox — Process Isolation
// ============================================================

export type SandboxMode = "off" | "per-agent" | "all";

export interface SandboxConfig {
  mode: SandboxMode;
  allowedPaths?: string[];
  allowedEnvVars?: string[];
  networkAccess?: boolean;
  maxMemoryMb?: number;
  maxCpuPercent?: number;
}

/**
 * Sandbox policy enforcement for file system access
 */
export class FilesystemSandbox {
  private allowedPaths: string[];
  private logger?: Logger;

  constructor(allowedPaths: string[], logger?: Logger) {
    this.allowedPaths = allowedPaths.map((p) => p.replace(/\/+$/, ""));
    this.logger = logger;
  }

  /**
   * Check if a file path is within the sandbox
   */
  isPathAllowed(filePath: string): boolean {
    const normalized = filePath.replace(/\/+$/, "");

    for (const allowed of this.allowedPaths) {
      if (normalized === allowed || normalized.startsWith(allowed + "/")) {
        return true;
      }
    }

    this.logger?.warn(`Sandbox violation: ${filePath}`);
    return false;
  }

  /**
   * Assert path is allowed, throw if not
   */
  assertPathAllowed(filePath: string): void {
    if (!this.isPathAllowed(filePath)) {
      throw new Error(
        `Sandbox violation: access to "${filePath}" is not allowed. ` +
          `Allowed paths: ${this.allowedPaths.join(", ")}`
      );
    }
  }
}
