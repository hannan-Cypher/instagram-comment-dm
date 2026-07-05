// ─────────────────────────────────────────────────
// Webhook signature verification (X-Hub-Signature-256)
// ─────────────────────────────────────────────────
//
// WHY SIGNATURE VERIFICATION IS CRITICAL:
// Meta sends webhooks signed with your App Secret using HMAC-SHA256.
// Without verification, ANYONE who discovers your webhook URL could
// forge events — sending fake comments and triggering DMs at will.
// This would waste DM quota, potentially trigger Meta rate-limit
// blocks, and could be used to spam users.
//
// IMPLEMENTATION NOTES:
// - We hash the RAW request body (before any JSON parsing or whitespace
//   normalization). Express must deliver the raw body via the
//   express.raw() middleware or by capturing it before JSON parsing.
// - crypto.timingSafeEqual prevents timing attacks that could leak
//   the signature byte-by-byte over repeated comparisons.

import crypto from "node:crypto";
import config from "../config/index.js";
import logger from "../lib/logger.js";

// Expected signature prefix from Meta
const EXPECTED_PREFIX = "sha256=";

/**
 * Verify the X-Hub-Signature-256 header against the raw request body.
 *
 * @param {string|null|undefined} signatureHeader - Value of X-Hub-Signature-256
 * @param {Buffer} rawBody - Raw request body as a Buffer (must NOT be parsed/stringified)
 * @returns {boolean} - True if the signature is valid
 */
export function verifySignature(signatureHeader, rawBody) {
  // Reject if header is missing
  if (!signatureHeader || typeof signatureHeader !== "string") {
    logger.warn({ signatureHeader }, "Webhook signature header missing or invalid");
    return false;
  }

  // Validate the expected prefix
  if (!signatureHeader.startsWith(EXPECTED_PREFIX)) {
    logger.warn({ signatureHeader }, "Webhook signature header has unexpected format — expected sha256= prefix");
    return false;
  }

  // Extract the hex digest from the header
  const expectedSignature = signatureHeader.slice(EXPECTED_PREFIX.length);

  // Validate hex format — Meta signatures are lowercase hex
  if (!/^[0-9a-f]{64}$/.test(expectedSignature)) {
    logger.warn({ expectedSignature }, "Webhook signature header contains non-hex or wrong-length digest");
    return false;
  }

  // Compute HMAC-SHA256 of the raw body using App Secret as the key
  const hmac = crypto.createHmac("sha256", config.appSecret);
  hmac.update(rawBody);
  const computedSignature = hmac.digest("hex");

  // Constant-time comparison to prevent timing side-channel attacks
  // WHY: If an attacker can measure response time differences between
  // "first byte matches" and "first byte mismatches", they can
  // brute-force the signature byte-by-byte. timingSafeEqual takes
  // the same wall-clock time regardless of how many bytes match.
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const computedBuffer = Buffer.from(computedSignature, "hex");

  // Both buffers must be the same length for timingSafeEqual
  if (expectedBuffer.length !== computedBuffer.length) {
    logger.warn("Signature length mismatch during verification");
    return false;
  }

  const isValid = crypto.timingSafeEqual(expectedBuffer, computedBuffer);

  if (!isValid) {
    logger.warn("Webhook signature mismatch — possible forged request");
  }

  return isValid;
}
