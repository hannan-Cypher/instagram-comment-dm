// ─────────────────────────────────────────────────
// Webhook routes — verification (GET) + receiver (POST)
// ─────────────────────────────────────────────────
//
// GET  /webhook — Meta's "hub.challenge" handshake for webhook setup
// POST /webhook — Receive comment events from Meta

import { Router } from "express";
import config from "../config/index.js";
import logger from "../lib/logger.js";
import { verifySignature } from "../services/signature.js";
import { tryInsertComment } from "../services/idempotency.js";
import { commentDmQueue } from "../workers/queue.js";

const router = Router();

// ─────────────────────────────────────────────────
// GET /webhook — Verification handshake
// ─────────────────────────────────────────────────
//
// When you configure a webhook in the Meta Developer Portal,
// Meta sends a GET request with:
//   hub.mode     = "subscribe"
//   hub.challenge = <random string>
//   hub.verify_token = <your verify token>
//
// If the verify_token matches, respond with hub.challenge
// as plain text. This proves you control the endpoint.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = req.query["hub.verify_token"];

  logger.info({ mode, verifyToken }, "Webhook verification request received");

  if (mode === "subscribe" && verifyToken === config.verifyToken) {
    logger.info("Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  logger.warn({ mode, verifyToken }, "Webhook verification failed — token mismatch or bad mode");
  return res.status(403).send("Verification failed");
});

// ─────────────────────────────────────────────────
// POST /webhook — Receive comment events
// ─────────────────────────────────────────────────
//
// Meta sends POST requests with JSON payloads when events occur.
// We process "comments" events from Instagram Professional accounts.
//
// The raw body is captured BEFORE JSON parsing (see index.js)
// so signature verification works on the exact bytes Meta sent.
router.post("/webhook", async (req, res) => {
  // ── Step 1: Verify X-Hub-Signature-256 ──
  // WHY FIRST? Reject forged payloads before wasting any resources
  // (DB writes, queue enqueues, etc.). Invalid sig = drop immediately.
  const signature = req.headers["x-hub-signature-256"];
  // req.rawBody is attached by the middleware in index.js
  if (!verifySignature(signature, req.rawBody)) {
    return res.status(403).json({ error: "Invalid signature" });
  }

  // ── Step 2: Parse and validate payload ──
  const payload = req.body;

  if (!payload || !payload.entry || !Array.isArray(payload.entry)) {
    logger.warn({ payload }, "Webhook payload missing entry array");
    return res.status(400).json({ error: "Invalid payload structure" });
  }

  // Determine object type — we only care about "instagram"
  const objectType = payload.object;
  if (objectType !== "instagram") {
    logger.debug({ objectType }, "Ignoring non-Instagram webhook object");
    return res.status(200).json({ status: "ignored", reason: "Not an Instagram object" });
  }

  let processedCount = 0;
  let ignoredCount = 0;

  // ── Step 3: Iterate over entries and changes ──
  for (const entry of payload.entry) {
    if (!entry.changes || !Array.isArray(entry.changes)) {
      continue;
    }

    for (const change of entry.changes) {
      // We only care about "comments" events
      if (change.field !== "comments") {
        continue;
      }

      const value = change.value;

      // Extract required fields from the comment webhook payload
      // The "from" object contains the commenter's IGSID
      // The "id" is the comment ID (mid)
      const commentId = value?.id;
      const igsid = value?.from?.id;
      const commentText = value?.text ?? "";
      const mediaId = value?.media?.id;
      const timestamp = value?.timestamp;

      if (!commentId || !igsid) {
        logger.warn({ value }, "Comment payload missing required id or igsid — skipping");
        ignoredCount++;
        continue;
      }

      logger.info(
        { commentId, igsid, commentTextPreview: commentText.slice(0, 60), mediaId },
        "Processing comment webhook event"
      );

      // ── Step 4: Case-insensitive trigger keyword check ──
      // WHY CHECK BEFORE IDEMPOTENCY? Avoid unnecessary DB reads
      // for comments that will never trigger a DM.
      if (!commentText.toLowerCase().includes(config.triggerKeyword.toLowerCase())) {
        logger.debug(
          { commentId, keyword: config.triggerKeyword },
          "Comment does not contain trigger keyword — ignoring"
        );
        ignoredCount++;
        continue;
      }

      // ── Step 5: Idempotency check — insert before enqueue ──
      // WHY BEFORE ENQUEUE? If the server crashes between enqueue
      // and DB write, we'd have an orphan queue job. Inserting first
      // guarantees the DB has the record. If it's a duplicate (P2002),
      // we skip silently.
      const { saved, record } = await tryInsertComment(commentId, igsid, commentText);

      if (!saved) {
        logger.info({ commentId, status: record?.status }, "Duplicate comment — already processed");
        ignoredCount++;
        continue;
      }

      // ── Step 6: Enqueue BullMQ job ──
      await commentDmQueue.add(
        "send-dm",
        {
          recordId: record.id,
          commentId,
          igsid,
          messageText: config.dmMessageText,
          commentTimestamp: timestamp,
          // Only include button config if both title AND url are configured
          ...(config.dmButton.title && config.dmButton.url
            ? { button: { title: config.dmButton.title, url: config.dmButton.url } }
            : {}),
        },
        {
          // WHY removeOnComplete? We keep idempotency in the DB,
          // so completed jobs don't need to persist in Redis.
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400, count: 1000 },
        }
      );

      logger.info({ commentId, igsid, jobId: record.id }, "Enqueued DM send job");
      processedCount++;
    }
  }

  // ── Step 7: Acknowledge the webhook ──
  // Meta expects a 200 OK to stop retrying. We always return 200
  // unless the signature was invalid (already returned 403).
  logger.info({ processedCount, ignoredCount }, "Webhook processed");

  return res.status(200).json({
    status: "ok",
    processed: processedCount,
    ignored: ignoredCount,
  });
});

export default router;
