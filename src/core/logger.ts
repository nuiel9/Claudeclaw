import type { Logger } from "./types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";

const SENSITIVE_KEYS = new Set([
  "token",
  "secret",
  "password",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "private_key",
  "privatekey",
]);

function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function createLogger(
  prefix: string,
  level: LogLevel = "info"
): Logger {
  const minLevel = LOG_LEVELS[level];

  function log(
    lvl: LogLevel,
    msg: string,
    meta?: Record<string, unknown>
  ): void {
    if (LOG_LEVELS[lvl] < minLevel) return;
    const ts = new Date().toISOString();
    const color = COLORS[lvl];
    const sanitized = meta ? redactSensitive(meta) : undefined;
    const metaStr = sanitized ? ` ${JSON.stringify(sanitized)}` : "";
    const line = `${color}[${ts}] [${lvl.toUpperCase()}] [${prefix}]${RESET} ${msg}${metaStr}`;
    if (lvl === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, meta?) => log("debug", msg, meta),
    info: (msg, meta?) => log("info", msg, meta),
    warn: (msg, meta?) => log("warn", msg, meta),
    error: (msg, meta?) => log("error", msg, meta),
  };
}
