// ─────────────────────────────────────────────────
// Configuration — validated at startup
// ─────────────────────────────────────────────────
//
// Fails LOUDLY if any required env var is missing.
// This prevents a silently misconfigured server
// that accepts webhooks but fails to send DMs.

import "dotenv/config";

const requiredVars = [
  "PAGE_ACCESS_TOKEN",
  "APP_SECRET",
  "VERIFY_TOKEN",
  "DATABASE_URL",
  "REDIS_URL",
  "TRIGGER_KEYWORD",
  "DM_MESSAGE_TEXT",
] ;

const missing = requiredVars.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `FATAL: Missing required environment variables:\n  ${missing.join("\n  ")}`
  );
  process.exit(1);
}

const config = Object.freeze({
  port: parseInt(process.env.PORT ?? "3000", 10),

  // Meta / Facebook App
  pageAccessToken: process.env.PAGE_ACCESS_TOKEN,
  appSecret: process.env.APP_SECRET,
  verifyToken: process.env.VERIFY_TOKEN,

  // Meta Graph API base — use latest confirmed version
  graphApiBase: process.env.GRAPH_API_BASE ?? "https://graph.facebook.com/v21.0",

  // Databases
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,

  // Trigger keyword — case-insensitive match against comment text
  triggerKeyword: process.env.TRIGGER_KEYWORD,

  // DM message template (plain text — always required as fallback)
  dmMessageText: process.env.DM_MESSAGE_TEXT,

  // Optional button configuration.
  // If DM_BUTTON_TITLE and DM_BUTTON_URL are both set, the DM is sent as
  // a button template instead of plain text. The button opens the URL.
  // Useful for "Get Link" / "Visit Site" / "Learn More" CTAs.
  dmButton: Object.freeze({
    title: process.env.DM_BUTTON_TITLE ?? null,
    url: process.env.DM_BUTTON_URL ?? null,
  }),

  // Rate limit: Meta enforces 200 DMs/hour per Instagram Professional account.
  // We configure BullMQ's limiter to match. Jobs above this threshold queue
  // and automatically spill into the next window — they never drop.
  rateLimit: Object.freeze({
    maxPerHour: 200,
    windowMs: 3_600_000, // 1 hour in ms
  }),

  // BullMQ job retry: 3 attempts with exponential backoff.
  // WHY capped? If the API keeps failing (private account, token revoked, etc.),
  // retrying more would waste resources and risk rate-limit penalties.
  // 3 attempts means ~ immediate + ~5s + ~25s — enough for transient blips,
  // not enough to hammer Meta on a persistent failure.
  jobRetries: Object.freeze({
    maxAttempts: 3,
    backoffType: "exponential",
    backoffDelay: 5000, // base 5 seconds, doubles each attempt
  }),

  // 24-hour DM window: Meta only allows businesses to message a user
  // for 24 hours after the user's last interaction (the comment).
  // After that, only standard messaging tags or paid messaging apply.
  // We enforce this server-side as a safety net.
  dmWindowHours: 24,
});

export default config;
