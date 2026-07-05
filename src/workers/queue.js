// ─────────────────────────────────────────────────
// BullMQ Queue — DM send jobs
// ─────────────────────────────────────────────────
//
// WHY BULLMQ + REDIS:
// Webhooks arrive in bursts (a viral post can get 1000+
// comments in minutes). BullMQ queues jobs to Redis and
// the worker processes them at a controlled rate. This:
//   1. Prevents overwhelming the Meta API (enforcing 200/hr)
//   2. Survives server restarts (Redis persists the queue)
//   3. Provides retry with backoff (transient failures recover)
//
// RATE LIMITER CONFIG:
//   max: 200 jobs per 3600000ms (1 hour)
//   This mirrors Meta's 200 DMs/hour limit.
//   Jobs beyond 200 queue automatically and spill into
//   the next window — they never drop.
//
//   WHY 200? Meta enforces this per Instagram Professional
//   account. Exceeding it triggers a 368 error and can
//   lead to temporary blocks. Better to self-throttle.

import { Queue } from "bullmq";
import IORedis from "ioredis";
import config from "../config/index.js";
import logger from "../lib/logger.js";

const redis = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null, // BullMQ manages its own retries
  enableReadyCheck: false,
});

redis.on("error", (err) => {
  logger.error({ err }, "Redis connection error");
});

redis.on("connect", () => {
  logger.info("Connected to Redis");
});

/**
 * DM send queue.
 *
 * The rate limiter allows max 200 jobs per 3600000ms.
 * This is a "smoothing" limiter — BullMQ spreads jobs
 * across the window rather than accepting 200 then blocking
 * the rest. Jobs are never dropped; they wait in the queue.
 */
export const commentDmQueue = new Queue("comment-dm", {
  connection: redis,
  defaultJobOptions: {
    attempts: config.jobRetries.maxAttempts,
    backoff: {
      type: config.jobRetries.backoffType,
      delay: config.jobRetries.backoffDelay,
    },
    // WHY 3 attempts with exponential backoff:
    //   Attempt 1: immediate
    //   Attempt 2: ~5 seconds later
    //   Attempt 3: ~25 seconds later
    //   Total: ~30 seconds of retry window
    // If the API still fails after 3 attempts, it's likely
    // a permanent error (token expired, user unreachable, etc.)
    // and further retries would waste resources.
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
  limiter: {
    max: config.rateLimit.maxPerHour,
    duration: config.rateLimit.windowMs,
  },
});

/**
 * Get the Redis connection (for worker and graceful shutdown).
 */
export function getRedisConnection() {
  return redis;
}

/**
 * Gracefully close the queue and Redis connection.
 */
export async function closeQueue() {
  await commentDmQueue.close();
  await redis.quit();
}
