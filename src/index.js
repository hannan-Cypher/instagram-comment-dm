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
