# Instagram Comment-to-DM

Automatically sends a direct message to Instagram users who comment a specific trigger keyword under your Reels or posts.

**Architecture:** Node.js + Express → BullMQ (Redis) → Meta Graph API  
**Idempotency store:** PostgreSQL via Prisma ORM  
**Logging:** Pino (structured JSON)

---

## How It Works

```
User comments "ORDER" on your Reel
        │
        ▼
Meta sends webhook POST to /webhook
        │
  ┌─────┴─────┐
  │ Verify    │  X-Hub-Signature-256 (HMAC-SHA256)
  │ signature │  Reject with 403 if invalid
  └─────┬─────┘
        │
  ┌─────┴─────┐
  │ Check     │  Case-insensitive: does comment contain TRIGGER_KEYWORD?
  │ trigger   │  If no → silently ignore
  └─────┬─────┘
        │
  ┌─────┴─────┐
  │ Insert DB │  UNIQUE(commentId) — idempotency
  │ record    │  Duplicate commentId → skip silently
  └─────┬─────┘
        │
  ┌─────┴─────┐
  │ Enqueue   │  BullMQ job → Redis queue
  │ BullMQ    │  Rate limiter: 200 jobs/hour
  └─────┬─────┘
        │
  ┌─────┴─────┐
  │ Worker    │  1. Check 24h window → expire if too late
  │ sends DM  │  2. POST /me/messages with PAGE_ACCESS_TOKEN
  │           │  3. Mark DB record: sent/expired/failed
  └───────────┘
```

---

## Prerequisites

### Meta / Instagram Requirements

1. **Instagram Professional Account** — your Instagram account must be a **Business** or **Creator** account.
2. **Facebook Page** — your Instagram account must be linked to a Facebook Page (this is how the Graph API identifies your business).
3. **Facebook App** — a Facebook App in **Development Mode** (switch to Live when ready).
4. **Advanced Access** for the following permissions (requires App Review):
   - `instagram_manage_comments` — receive comment webhooks
   - `instagram_manage_messages` — send DMs via Graph API
5. **Page Access Token** — generated from the Facebook Page linked to your Instagram account, with the above permissions.
6. **Webhook subscribed** to the `comments` field for your Instagram Professional account.

### Local Development

- **Node.js** >= 18 (native fetch required)
- **Docker** (for PostgreSQL + Redis via docker-compose)

---

## Setup

### 1. Clone and install

```bash
cd instagram-comment-dm
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

| Variable | Description |
|----------|-------------|
| `PAGE_ACCESS_TOKEN` | Facebook Page Access Token with `instagram_manage_comments` and `instagram_manage_messages` |
| `APP_SECRET` | Your Facebook App Secret (from App Dashboard → Settings → Basic) |
| `VERIFY_TOKEN` | Any string you choose — used during webhook setup handshake |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `TRIGGER_KEYWORD` | Case-insensitive keyword (e.g., `ORDER`, `PRICE`, `INFO`) |
| `DM_MESSAGE_TEXT` | The automated DM text sent to matching commenters |

### 3. Start infrastructure

```bash
docker compose up -d
# Starts PostgreSQL (5432) and Redis (6379)
```

### 4. Initialize the database

```bash
npm run db:push
# Creates the ProcessedComment table
```

### 5. Start the server

```bash
npm run dev
# Server starts on PORT (default 3000)
```

### 6. Configure the webhook in Meta Developer Portal

1. Go to your app → **Products** → **Webhooks**.
2. Set the callback URL to `https://your-public-domain.com/webhook`.
3. Set the verify token to your `VERIFY_TOKEN`.
4. Subscribe to the **comments** field for your Instagram Professional account.
5. Meta will send a GET request to your `/webhook` endpoint — this server handles the verification handshake automatically.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/webhook?hub.mode=subscribe&hub.challenge=...&hub.verify_token=...` | Webhook verification (Meta calls this) |
| `POST` | `/webhook` | Receive comment events (Meta calls this) |

---

## Rate Limiting

Meta enforces **200 DMs per hour** per Instagram Professional account. This system matches that limit:

- **BullMQ limiter:** max 200 jobs per 3600 seconds (1 hour).
- Jobs beyond 200 **automatically queue** and spill into the next hour — they are never dropped.
- The worker runs at **concurrency 1** to naturally pace API calls.
- If Meta returns a 368 (rate-limit) error, the job retries with exponential backoff (up to 3 attempts).

---

## Hard Constraints (implemented)

### 24-Hour DM Window
Meta policy only allows messaging a user within 24 hours of their last interaction. The worker proactively checks this before calling the API. If the window has expired, the job is marked "expired" and skipped — no API call is made.

### Signature Verification
Every webhook POST is verified using `X-Hub-Signature-256` (HMAC-SHA256 with `APP_SECRET`). Invalid signatures receive a 403 response. This prevents forged webhook requests from triggering DMs.

### Idempotency
The `commentId` from Meta is stored as a UNIQUE column in PostgreSQL. Before enqueuing a DM job, the system attempts to insert the comment record. If the `commentId` already exists (duplicate webhook delivery), it's silently ignored. This prevents double-sending even if Meta redelivers the same event.

---

## Project Structure

```
instagram-comment-dm/
├── .env.example          # Environment variable template
├── docker-compose.yml    # Local PostgreSQL + Redis
├── package.json
├── README.md
└── src/
    ├── index.js          # Express server entry point + graceful shutdown
    ├── config/
    │   └── index.js      # Env validation, defaults, frozen config object
    ├── lib/
    │   └── logger.js     # Pino structured logger
    ├── prisma/
    │   └── schema.prisma # ProcessedComment model (idempotency + audit)
    ├── routes/
    │   └── webhook.js    # GET (verify) + POST (receive) webhook handlers
    ├── services/
    │   ├── idempotency.js # Prisma operations for dedup + audit
    │   ├── instagram.js   # Meta Graph API client (send DMs)
    │   └── signature.js   # X-Hub-Signature-256 verification with timingSafeEqual
    └── workers/
        ├── queue.js       # BullMQ queue definition + Redis connection
        └── worker.js      # Job processor with 24h window check + error classification
```

---

## Error Handling Strategy

| Error Type | Behavior |
|-----------|----------|
| **Transient** (rate-limited, network timeout) | Retry up to 3 times with exponential backoff (5s → 25s → ~125s) |
| **Permanent** (token expired, invalid IGSID, permission missing) | Mark "failed" immediately — no retry |
| **24h window expired** | Mark "expired" — no API call made |
| **Signature mismatch** | Return 403 — no processing |
| **Duplicate comment** | Skip silently — idempotency |

---

## Graceful Shutdown

The server handles SIGTERM/SIGINT:
1. Stops accepting new HTTP connections
2. Waits for in-flight BullMQ jobs to finish
3. Closes the queue connection
4. Disconnects Prisma (releases the connection pool)
5. Exits (with 10-second hard timeout)

---

## Monitoring

Logs are structured JSON (Pino). Default level is `info`. Set `LOG_LEVEL=debug` for verbose output.

```bash
LOG_LEVEL=debug npm run dev
```

Logs include:
- Webhook receipt (comment ID, IGSID, text preview)
- Signature verification results
- Idempotency decisions (inserted vs duplicate)
- DM send attempts + results + error codes
- Worker job lifecycle (queued → processing → completed/failed)
- Rate limiter state

---

## Security Notes

- **Never** commit `.env` to version control.
- The `APP_SECRET` is never exposed in responses or logs.
- Webhook URL should use HTTPS (Meta enforces this).
- The `PAGE_ACCESS_TOKEN` is stored only in the environment, never hardcoded.
- Signature verification uses `crypto.timingSafeEqual` to prevent timing side-channel attacks.

---

## License

MIT
