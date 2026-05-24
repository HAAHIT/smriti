import { appendFileSync } from "node:fs";
import { logPath } from "./paths.js";

const LOG_FILE = logPath();

function fmt(level: string, msg: string, extra?: Record<string, unknown>): string {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(extra ?? {}),
  };
  return JSON.stringify(line) + "\n";
}

export const log = {
  info(msg: string, extra?: Record<string, unknown>) {
    try {
      appendFileSync(LOG_FILE, fmt("info", msg, extra));
    } catch {
      /* swallow — never crash on logging */
    }
  },
  warn(msg: string, extra?: Record<string, unknown>) {
    try {
      appendFileSync(LOG_FILE, fmt("warn", msg, extra));
    } catch {
      /* swallow */
    }
  },
  error(msg: string, extra?: Record<string, unknown>) {
    try {
      appendFileSync(LOG_FILE, fmt("error", msg, extra));
    } catch {
      /* swallow */
    }
  },
};
