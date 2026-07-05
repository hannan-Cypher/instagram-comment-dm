// ─────────────────────────────────────────────────
// Instagram Comment-to-DM — Server Entry Point
// ─────────────────────────────────────────────────
//
// Sets up Express with:
//   1. Raw body capture (for signature verification)
//   2. JSON body parsing
//   3. Webhook routes
//   4. Graceful shutdown

import express from "express";
import config from "./config/index.js";
import logger from "./lib/logger.js";
import webhookRouter from "./routes/webhook.js";
import { closeQueue } from "./workers/queue.js";
import { closeWorker } from "./workers/worker.js";
import { disconnectPrisma } from "./services/idempotency.js";

const app = express();

// ─────────────────────────────────────────────────
// Middleware: Raw body capture
// ─────────────────────────────────────────────────
//
// CRITICAL: Signature verification needs the RAW request body
// (exact bytes as received). JSON parsing modifies the body
// (strips whitespace, normalizes encodings).
//
// We capture the raw body BEFORE the JSON parser. The raw body
// is stored as a Buffer on req.rawBody for the verifySignature
// function.
//
// We only capture for /webhook to avoid unnecessary buffering
// on other routes.
app.use(
  "/webhook",
  express.raw({
    type: "application/json",
    limit: "1mb",
  }),
  (req, _res, next) => {
    // Store raw body buffer for signature verification
    req.rawBody = req.body;
    // Now parse the raw buffer back to JSON for req.body
    try {
      req.body = JSON.parse(req.body.toString("utf-8"));
    } catch {
      req.body = {};
    }
    next();
  }
);

// ─────────────────────────────────────────────────
// Middleware: Standard JSON parsing (non-webhook routes)
// ─────────────────────────────────────────────────
app.use(express.json());

// ── Health check ──
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "instagram-comment-dm" });
});

// ── Privacy Policy (required by Meta to go Live) ──
app.get("/privacy", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — Zauq e Zaika</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #222; }
    h1 { font-size: 1.8rem; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
    h2 { font-size: 1.2rem; margin-top: 28px; color: #444; }
    p { margin: 8px 0; }
    .updated { color: #888; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: July 5, 2026</p>

  <h2>1. Overview</h2>
  <p>Zauq e Zaika ("we", "us") operates an Instagram automation service that sends direct messages to users who comment specific keywords on our posts. This policy explains what data we collect and how we use it.</p>

  <h2>2. Data We Collect</h2>
  <p>When you comment on our Instagram posts, we receive the following data from Meta's webhook API:</p>
  <ul>
    <li>Your Instagram-scoped user ID (IGSID)</li>
    <li>The text of your comment</li>
    <li>The comment ID and timestamp</li>
  </ul>
  <p>We do <strong>not</strong> collect your email, phone number, real name, or any other personal information.</p>

  <h2>3. How We Use Your Data</h2>
  <p>Your data is used solely to:</p>
  <ul>
    <li>Detect trigger keywords in your comment</li>
    <li>Send you a one-time direct message with the requested content</li>
    <li>Prevent duplicate messages (idempotency)</li>
  </ul>

  <h2>4. Data Storage &amp; Retention</h2>
  <p>Comment records are stored in a secure PostgreSQL database. We retain records for up to 90 days for operational purposes, after which they are deleted.</p>

  <h2>5. Data Sharing</h2>
  <p>We do <strong>not</strong> sell, rent, or share your data with any third parties. Data is only transmitted between our server and Meta's API.</p>

  <h2>6. Your Rights</h2>
  <p>You may request deletion of your data at any time by contacting us via Instagram DM at <strong>@hannan.mohsin.514</strong>.</p>

  <h2>7. Contact</h2>
  <p>For questions about this privacy policy, message us on Instagram: <strong>@hannan.mohsin.514</strong></p>
</body>
</html>`);
});

// ── Webhook routes ──
app.use(webhookRouter);

// ── Start server ──
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "Instagram Comment-to-DM server started");
  logger.info({ triggerKeyword: config.triggerKeyword }, "Configured trigger keyword");
  logger.info(
    { maxPerHour: config.rateLimit.maxPerHour, windowMs: config.rateLimit.windowMs },
    "Rate limiter active"
  );
});

// ─────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────
//
// On SIGTERM/SIGINT we:
//   1. Stop accepting new HTTP requests
//   2. Close BullMQ worker (finish in-flight jobs)
//   3. Close BullMQ queue
//   4. Disconnect Prisma (release DB pool)
//   5. Exit

async function shutdown(signal) {
  logger.info({ signal }, "Shutdown signal received — closing gracefully");

  server.close(async () => {
    logger.info("HTTP server closed");

    try {
      await closeWorker();
      logger.info("BullMQ worker closed");
    } catch (err) {
      logger.error({ err }, "Error closing worker");
    }

    try {
      await closeQueue();
      logger.info("BullMQ queue closed");
    } catch (err) {
      logger.error({ err }, "Error closing queue");
    }

    try {
      await disconnectPrisma();
      logger.info("Prisma disconnected");
    } catch (err) {
      logger.error({ err }, "Error disconnecting Prisma");
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  });

  // Force exit after 10s if graceful shutdown hangs
  setTimeout(() => {
    logger.error("Graceful shutdown timed out — force exiting");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
