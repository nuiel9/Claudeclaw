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
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
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
