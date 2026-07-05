// ─────────────────────────────────────────────────
// Structured logger — pino
// ─────────────────────────────────────────────────
//
// Pino is chosen over Winston for:
//   - ~3x faster serialization (critical for high-throughput webhook ingestion)
//   - Native ESM support
//   - Lower memory overhead per log line
//   - JSON output by default (ideal for log aggregators: DataDog, ELK, etc.)

import pino from "pino";

// In production, omit pino-pretty (use JSON lines for log ingestion).
// pino-pretty is only active when NODE_ENV is not "production".
const transport =
  process.env.NODE_ENV !== "production"
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }
    : undefined;

const logger = pino({
  name: "instagram-comment-dm",
  level: process.env.LOG_LEVEL ?? "info",
  ...(transport ? { transport } : {}),
});

export default logger;
