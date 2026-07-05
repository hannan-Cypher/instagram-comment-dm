// ─────────────────────────────────────────────────
// Meta Instagram Graph API client
// ─────────────────────────────────────────────────
//
// Thin wrapper around the /me/messages endpoint.
// We send DMs using the Page-scoped Instagram Messaging API.
// All requests use the Page Access Token (not a user token).

import config from "../config/index.js";
import logger from "../lib/logger.js";

const API_BASE = config.graphApiBase;

/**
 * Meta API error codes we explicitly handle:
 *   - 10:       App secret / token validation failure
 *   - 100:      Invalid parameter (malformed IGSID, message too long, etc.)
 *   - 200:      Permission error / access token lacks required scope
 *   - 368:      Temporarily blocked (rate limit or spam detection)
 *   - 551:      User is unreachable (private account, not following, 24h window expired)
 *   - 190:      Access token has expired or been revoked
 */
const KNOWN_ERROR_CODES = {
  TOKEN_INVALID: 10,
  INVALID_PARAMETER: 100,
  PERMISSION_ERROR: 200,
  RATE_LIMITED: 368,
  USER_UNREACHABLE: 551,
  TOKEN_EXPIRED: 190,
};

/**
 * Send a DM to an Instagram user via the /me/messages endpoint.
 *
 * Supports two message formats:
 *   1. PLAIN TEXT — when `button` is null/undefined
 *   2. BUTTON TEMPLATE — when `button` has { title, url }
 *      The button opens the URL in the Instagram in-app browser.
 *
 * @param {string} igsid - Instagram-Scoped User ID (from webhook payload)
 * @param {string} messageText - The DM text (or template text above the button)
 * @param {{ title: string|null, url: string|null }|null} [button] - Optional button config
 * @returns {Promise<{success: boolean, messageId?: string, error?: object}>}
 */
export async function sendDirectMessage(igsid, messageText, button = null) {
  const url = `${API_BASE}/me/messages`;

  // Build the message payload — plain text or button template
  let messagePayload;
  let contentType;

  if (button?.title && button?.url) {
    // ── Button template message ──
    // Instagram Messaging API supports button templates with web_url buttons.
    // The button opens the URL in Instagram's in-app browser.
    messagePayload = {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: messageText,
          buttons: [
            {
              type: "web_url",
              url: button.url,
              title: button.title,
            },
          ],
        },
      },
    };
    contentType = "button_template";
  } else {
    // ── Plain text message ──
    messagePayload = { text: messageText };
    contentType = "plain_text";
  }

  const payload = {
    recipient: { id: igsid },
    message: messagePayload,
    messaging_type: "RESPONSE",
    access_token: config.pageAccessToken,
  };

  logger.info({ igsid, contentType, textLength: messageText.length }, "Sending DM via Meta API");

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (networkError) {
    // Network-level failure (DNS, timeout, connection reset) — NOT a Meta API error
    logger.error(
      { igsid, error: networkError.message },
      "Network error while calling Meta Graph API — will retry via BullMQ backoff"
    );
    return {
      success: false,
      error: {
        code: "NETWORK_ERROR",
        message: networkError.message,
        isTransient: true, // transient — worth retrying
      },
    };
  }

  const body = await response.json().catch(() => null);

  if (response.ok && body?.message_id) {
    logger.info({ igsid, messageId: body.message_id }, "DM sent successfully");
    return {
      success: true,
      messageId: body.message_id,
    };
  }

  // Parse error response
  const error = body?.error ?? { code: "UNKNOWN", message: response.statusText };
  const errorCode = error.code;

  logger.warn(
    { igsid, httpStatus: response.status, errorCode: errorCode, errorMessage: error.message },
    "Meta API returned an error"
  );

  // Classify the error — is it worth retrying?
  const isTransient = classifyErrorForRetry(errorCode);

  return {
    success: false,
    error: {
      code: errorCode,
      message: error.message,
      errorSubcode: error.error_subcode,
      isTransient,
    },
  };
}

/**
 * Determine if a Meta error code represents a transient failure worth retrying.
 *
 * PERMANENT (do NOT retry):
 *   - 10 / 190:    Token invalid/expired — needs human intervention
 *   - 100:         Bad parameters — retrying won't fix bad data
 *   - 200:         Missing permissions — needs App Review reconfiguration
 *   - 551:         24h window expired — recovers on next user interaction
 *
 * TRANSIENT (safe to retry with backoff):
 *   - 368:         Rate-limited — BullMQ's limiter already spaces us, but bursts can still 368
 *   - 2 / 4:       General temporary errors from Meta
 *   - network:     Timeout / connection issues
 *
 * @param {number|string} errorCode
 * @returns {boolean}
 */
function classifyErrorForRetry(errorCode) {
  switch (errorCode) {
    case KNOWN_ERROR_CODES.TOKEN_INVALID:
    case KNOWN_ERROR_CODES.INVALID_PARAMETER:
    case KNOWN_ERROR_CODES.PERMISSION_ERROR:
    case KNOWN_ERROR_CODES.TOKEN_EXPIRED:
    case KNOWN_ERROR_CODES.USER_UNREACHABLE:
      return false; // permanent — retrying is pointless
    case KNOWN_ERROR_CODES.RATE_LIMITED:
      return true; // transient — BullMQ backoff will help
    default:
      // Unknown codes are treated as transient to maximize delivery chances
      return true;
  }
}

export { KNOWN_ERROR_CODES };
