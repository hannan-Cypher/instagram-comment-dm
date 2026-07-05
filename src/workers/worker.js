// ─────────────────────────────────────────────────
// BullMQ Worker — Process DM send jobs
// ─────────────────────────────────────────────────
//
// The worker pulls jobs from the "comment-dm" queue one at a time
// (concurrency: 1 to stay under the 200/hr limit) and sends the DM
// via the Meta Graph API.
//
// JOB FLOW:
//   1. Check if 24-hour window has expired → mark "expired", skip
//   2. Call Meta API to send DM
//   3. On success → mark "sent"
//   4. On failure → if transient → retry (BullMQ backoff)
//                    if permanent → mark "failed" immediately
//
// WHY CONCURRENCY 1:
// With a rate limiter of 200/hr, running multiple workers
// concurrently just means they'd race the limiter and some
// would wait. A single worker at concurrency 1 is cleanest.

import { Worker } from "bullmq";
import config from "../config/index.js";
import logger from "../lib/logger.js";
import { getRedisConnection } from "./queue.js";
import { sendDirectMessage } from "../services/instagram.js";
import { updateCommentStatus } from "../services/idempotency.js";

// 24 hours in milliseconds
const WINDOW_MS = config.dmWindowHours * 60 * 60 * 1000;

const worker = new Worker(
  "comment-dm",
  async (job) => {
    const { recordId, igsid, messageText, commentTimestamp, button } = job.data;

    logger.info(
      { jobId: job.id, recordId, igsid, attempt: job.attemptsMade + 1 },
      "Worker processing DM send job"
    );

    // ── STEP 1: Enforce the 24-hour DM window ──
    //
    // WHY THE 24-HOUR RULE EXISTS:
    // Meta's Messenger Platform policy (applicable to Instagram DMs
    // via the Graph API) only allows businesses to send messages to
    // a user within 24 hours of that user's last interaction with
    // the business — in this case, the comment.
    //
    // After 24 hours:
    //   - The API returns error 551 (user unreachable)
    //   - You can only message with a "standard messaging" tag or
    //     via the paid messaging API
    //   - Attempting to DM outside the window can result in policy
    //     violations and feature restrictions
    //
    // We proactively check before calling the API to:
    //   a) Avoid a guaranteed API failure (wasting rate limit quota)
    //   b) Cleanly mark the job as expired for audit visibility
    //   c) Prevent accidental policy violations
    if (commentTimestamp) {
      const commentTime = new Date(commentTimestamp).getTime();
      const elapsed = Date.now() - commentTime;

      if (elapsed > WINDOW_MS) {
        logger.warn(
          { recordId, igsid, commentTimestamp, elapsedHours: Math.round(elapsed / 3600000) },
          "24-hour DM window expired — marking job as expired"
        );
        await updateCommentStatus(recordId, "expired");
        // Return without error — this is intentional, not a failure
        return { status: "expired", reason: "24-hour DM window elapsed" };
      }

      logger.debug(
        { recordId, elapsedHours: Math.round(elapsed / 3600000) },
        "Within 24-hour window — proceeding"
      );
    } else {
      logger.warn(
        { recordId, igsid },
        "No comment timestamp in job data — unable to enforce 24-hour window. Proceeding anyway."
      );
    }

    // ── STEP 2: Send the DM ──
    const result = await sendDirectMessage(igsid, messageText, button ?? null);

    if (result.success) {
      await updateCommentStatus(recordId, "sent");
      logger.info({ recordId, igsid, messageId: result.messageId }, "DM sent successfully");
      return { status: "sent", messageId: result.messageId };
    }

    // ── STEP 3: Handle API error ──
    const { code, message, isTransient } = result.error;

    logger.warn(
      { recordId, igsid, errorCode: code, errorMessage: message, isTransient, attempt: job.attemptsMade + 1 },
      "Failed to send DM"
    );

    if (isTransient) {
      // Throw to trigger BullMQ's retry mechanism (exponential backoff)
      // BullMQ will retry up to maxAttempts times, then move the job to "failed"
      throw new Error(`Meta API transient error [${code}]: ${message}`);
    }

    // Permanent failure — mark as failed, do NOT retry
    await updateCommentStatus(recordId, "failed");
    logger.error(
      { recordId, igsid, errorCode: code, errorMessage: message },
      "Permanent Meta API error — marking as failed, not retrying"
    );
    return { status: "failed", reason: `Permanent error [${code}]: ${message}` };
  },
  {
    connection: getRedisConnection(),
    concurrency: 1,
    limiter: {
      max: config.rateLimit.maxPerHour,
      duration: config.rateLimit.windowMs,
    },
    drainDelay: 30, // 30 seconds wait when queue is empty (saves Upstash commands)
  }
);

// ── Event handlers ──
worker.on("completed", (job) => {
  logger.info({ jobId: job.id, returnValue: job.returnvalue }, "Job completed");
});

worker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, error: err.message, attempts: job?.attemptsMade },
    "Job failed after all retries exhausted"
  );
});

worker.on("error", (err) => {
  logger.error({ err }, "Worker encountered an error");
});

logger.info("DM send worker initialized");

/**
 * Gracefully close the worker.
 */
export async function closeWorker() {
  await worker.close();
}

export default worker;
