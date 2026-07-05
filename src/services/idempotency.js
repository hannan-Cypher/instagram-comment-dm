// ─────────────────────────────────────────────────
// Idempotency service — Prisma operations for dedup
// ─────────────────────────────────────────────────
//
// WHY IDEMPOTENCY IS CRITICAL:
// Meta's webhook delivery is "at least once" — the same
// comment event CAN be delivered multiple times (e.g. if
// Meta's servers retry after a transient ack failure).
// Without idempotency, a single comment could trigger
// multiple DMs, annoying the user and wasting DM quota.
//
// STRATEGY: "Insert-before-enqueue"
// We insert a ProcessedComment row (commentId UNIQUE) in
// the webhook receiver BEFORE pushing the BullMQ job.
// If the row already exists (duplicate webhook), we skip
// everything. This guarantees that:
//   1. Duplicate webhooks are silently ignored
//   2. Even if the server crashes after enqueue but before
//      sending, the DB knows we attempted it
//   3. Re-processing a failed job doesn't create a duplicate row

import { PrismaClient } from "@prisma/client";
import logger from "../lib/logger.js";

const prisma = new PrismaClient();

/**
 * Attempt to insert a comment record for idempotency.
 *
 * @param {string} commentId - Meta's comment identifier (mid)
 * @param {string} igsid - Instagram-Scoped User ID
 * @param {string} commentText - Raw comment text
 * @returns {Promise<{saved: boolean, record: object|null}>}
 *   - saved: true if this was a NEW insertion
 *   - saved: false if the commentId already exists (duplicate)
 *   - record: the DB row (new or existing)
 */
export async function tryInsertComment(commentId, igsid, commentText) {
  try {
    const record = await prisma.processedComment.create({
      data: {
        commentId,
        igsid,
        commentText,
        status: "pending",
      },
    });

    logger.info({ commentId, igsid }, "Inserted new comment record — first time seeing this comment");

    return { saved: true, record };
  } catch (err) {
    // Prisma's P2002 = unique constraint violation
    if (err.code === "P2002" && err.meta?.target?.includes("commentId")) {
      logger.info({ commentId, igsid }, "Duplicate comment — commentId already processed, skipping");

      const existing = await prisma.processedComment.findUnique({
        where: { commentId },
      });

      return { saved: false, record: existing };
    }

    // Unexpected DB error — rethrow so the caller can handle it
    logger.error(
      { commentId, igsid, error: err.message, prismaCode: err.code },
      "Unexpected database error during idempotency insert"
    );
    throw err;
  }
}

/**
 * Update the status of a comment record.
 *
 * @param {number} id - The record's internal primary key
 * @param {string} status - "sent" | "expired" | "failed"
 * @param {object} [extra] - Extra fields to update
 * @returns {Promise<void>}
 */
export async function updateCommentStatus(id, status, extra = {}) {
  try {
    await prisma.processedComment.update({
      where: { id },
      data: { status, ...extra },
    });

    logger.debug({ id, status }, "Updated comment record status");
  } catch (err) {
    // Log but don't throw — status updates are non-critical audit data
    logger.error({ id, status, error: err.message }, "Failed to update comment record status");
  }
}

/**
 * Check if a commentId exists in the database.
 * Used as a fast pre-check before full insert logic.
 *
 * @param {string} commentId
 * @returns {Promise<boolean>}
 */
export async function commentExists(commentId) {
  const count = await prisma.processedComment.count({
    where: { commentId },
  });
  return count > 0;
}

/**
 * Gracefully disconnect Prisma (call on shutdown).
 */
export async function disconnectPrisma() {
  await prisma.$disconnect();
}
