# Free Deployment Guide — $0, No Credit Card

Deploy the Instagram Comment-to-DM service **100% free** on three services:

| Service | Purpose | Free Tier | Card Needed? |
|---------|---------|-----------|:---:|
| **Koyeb** | Node.js server (always-on) | 512MB RAM, 2GB storage, always-on | ❌ No |
| **Neon** | PostgreSQL database | 500MB storage, 100 compute hours/mo | ❌ No |
| **Upstash** | Redis (for BullMQ queue) | 10MB, 10,000 commands/day | ❌ No |

**Total: $0.00/month, no credit card required anywhere.**

---

## Step 1: Set up Neon (PostgreSQL)

1. Go to [neon.tech](https://neon.tech) and sign up (GitHub or email — no credit card)
2. Click **Create a project**:
   - Name: `instagram-comment-dm`
   - Region: pick one closest to you
   - Click **Create**
3. On the project dashboard, find **Connection string** — copy it. It looks like:
   ```
   postgresql://user:password@ep-xxxx.us-east-2.aws.neon.tech/neondb
   ```
4. **Important:** Append `?sslmode=require` to the end:
   ```
   postgresql://user:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
5. Save this — it's your `DATABASE_URL`

---

## Step 2: Set up Upstash (Redis)

1. Go to [upstash.com](https://upstash.com) and sign up (GitHub — no credit card)
2. Click **Create Database**:
   - Name: `instagram-comment-dm`
   - Type: **Redis** (not Kafka, not Vector)
   - Region: choose same region as Neon (e.g., `us-east-2`)
   - Click **Create**
3. On the database page, find the **REST API** section. Copy the **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** — but we actually need the **TCP** endpoint for BullMQ.
4. Scroll to **Connection Details** → copy the **Endpoint** URL:
   ```
   us1-xxxx.upstash.io:6379
   ```
5. Click **Generate Password** or copy the existing password
6. Construct your Redis URL (for `.env`):
   ```
   rediss://default:<password>@<endpoint>
   ```
   Example:
   ```
   rediss://default:AXx8AAIabc123def456@us1-cuddly-labradoodle-12345.upstash.io:6379
   ```
   > The `rediss://` (with **double `s`**) enables TLS encryption — BullMQ via ioredis needs this for Upstash.

---

## Step 3: Push the schema to Neon

Before deploying, create the database table. Run this locally:

```bash
# From your project folder
DATABASE_URL="postgresql://..." npm run db:push
```

Where `DATABASE_URL` is the Neon connection string from Step 1 (with `?sslmode=require`).

> Don't have Node.js locally? Skip this — the app creates the table on first run if you use `prisma db push` in a startup script. We'll handle this via Koyeb's build command.

---

## Step 4: Push your code to GitHub

1. Commit your code:
   ```bash
   git init
   git add .
   git commit -m "init: Instagram Comment-to-DM service"
   ```
2. Create a repository on [github.com](https://github.com) (free)
3. Push:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/instagram-comment-dm.git
   git branch -M main
   git push -u origin main
   ```

---

## Step 5: Deploy on Koyeb (the app)

1. Go to [koyeb.com](https://koyeb.com) and sign up (**no credit card needed** — use GitHub or email)

2. Click **Create App**

3. Choose **GitHub** as deployment method:
   - Install Koyeb GitHub app
   - Select your `instagram-comment-dm` repository
   - Branch: `main`

4. **App configuration:**
   - **Name:** `instagram-comment-dm`
   - **Builder:** **Dockerfile** (Koyeb auto-detects it)
   - **Port:** `3000`

5. **Environment variables** (click "Add Variable" for each):

   | Variable | Value |
   |----------|-------|
   | `PAGE_ACCESS_TOKEN` | Your Facebook Page Access Token |
   | `APP_SECRET` | Your Facebook App Secret |
   | `VERIFY_TOKEN` | Your chosen webhook verify token |
   | `DATABASE_URL` | Your Neon connection string with `?sslmode=require` |
   | `REDIS_URL` | Your Upstash Redis URL starting with `rediss://` |
   | `TRIGGER_KEYWORD` | e.g., `LINK` or `DM` |
   | `DM_MESSAGE_TEXT` | e.g., `Here's your link!` |
   | `DM_BUTTON_TITLE` | e.g., `Get Link` (optional — remove if not needed) |
   | `DM_BUTTON_URL` | e.g., `https://your-link.com` (optional) |
   | `NODE_ENV` | `production` |

6. **Health check** (optional but recommended):
   - Path: `/health`
   - Type: HTTP

7. Click **Deploy**

8. Wait 2–3 minutes for the build to finish. You'll see a URL like:
   ```
   https://instagram-comment-dm-yourname.koyeb.app
   ```

9. Test it:
   ```bash
   curl https://instagram-comment-dm-yourname.koyeb.app/health
   ```
   Expected response: `{"status":"ok","service":"instagram-comment-dm"}`

---

## Step 6: Run database migration

Koyeb can run the Prisma migration on deploy. Add this to your Koyeb app:

1. Go to your app → **Settings** → **Lifecycle** → **Build Command**
2. Set: `npx prisma db push --schema=src/prisma/schema.prisma`
3. This runs the migration every time you deploy

Or run it manually via Koyeb's web terminal if available.

---

## Step 7: Configure the webhook in Meta

1. Your server URL is:
   ```
   https://instagram-comment-dm-yourname.koyeb.app/webhook
   ```
2. Go to your Meta Developer Portal → Webhooks → Instagram
3. Set:
   - **Callback URL:** `https://instagram-comment-dm-yourname.koyeb.app/webhook`
   - **Verify Token:** (same as your `VERIFY_TOKEN`)
4. Click **Verify and Save**

---

## Redeploy after changes

When you push new code to GitHub, Koyeb auto-rebuilds and redeploys.

Or you can **manually redeploy** from the Koyeb dashboard → your app → **Redeploy**.

---

## Troubleshooting Free Tier Issues

### Webhook returns 504 (timeout)
Koyeb's free tier can cold-start if inactive. To keep it warm:
- Set up a **cron job** (Google Cloud Scheduler is free for 3 jobs) to hit `/health` every 5 minutes
- Or use [cron-job.org](https://cron-job.org) (free, no signup) — set it to ping `https://your-app.koyeb.app/health` every 5 minutes

### Database connection issues
- Make sure your `DATABASE_URL` ends with `?sslmode=require`
- Neon suspends after 5 minutes idle — the first query after idle takes 1–3 seconds to wake up

### Redis connection refused
- Make sure your `REDIS_URL` starts with `rediss://` (double `s`, for TLS)
- Upstash free tier limits: 10,000 commands/day — BullMQ uses a few commands per job, so ~300 DMs/day max (well within your 200/hr Meta limit)

### Instance runs out of memory
- Koyeb free tier has 512MB RAM — the Node app + BullMQ fits easily
- If you have issues, check for memory leaks in logs

---

## Alternative: Render (if Koyeb doesn't work)

If Koyeb's free tier changes in the future, **Render** also has a free tier:
- **No credit card required**
- Free web services **spin down after 15 min idle** (bad for webhooks!)
- Use [cron-job.org](https://cron-job.org) to ping every 10 min and keep it awake

**Verdict:** Koyeb is better because it doesn't spin down.

---

## Alternative: Fly.io (if you have a credit card)

If you eventually want more power and have a credit card:
- **Fly.io** free tier: 3 shared VPS (256MB RAM each) — never spins down
- Needs a credit card to verify ($0 charge)
- Deploy with `fly launch`

---

## Architecture overview on free tier

```
┌────────────┐    webhooks     ┌──────────────────────┐
│ Meta/IG    │ ──────────────► │  Koyeb (Node.js)     │
│            │                 │  512MB RAM always-on │
└────────────┘                 └──────┬───────────────┘
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                         ▼                         ▼
                  ┌────────────┐          ┌──────────────┐
                  │ Neon       │          │ Upstash      │
                  │ PostgreSQL │          │ Redis        │
                  │ 500MB free │          │ 10MB free    │
                  └────────────┘          └──────────────┘
```
