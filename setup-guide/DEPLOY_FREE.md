# Free Deployment Guide — $0, No Credit Card

Deploy the Instagram Comment-to-DM service **100% free**:

| Service | Purpose | Free Tier | Card Needed? |
|---------|---------|-----------|:---:|
| **Render** | Node.js server (with keep-alive) | 512MB RAM, 750 hrs/mo | ❌ No |
| **Neon** | PostgreSQL database | 500MB storage | ❌ No |
| **Upstash** | Redis (BullMQ queue) | 256MB, 500K commands/mo | ❌ No |
| **cron-job.org** | Keep Render awake | Unlimited | ❌ No |

**Total: $0.00/month, no credit card required anywhere.**

---

## ✅ Already done for you

| What | Status |
|------|--------|
| Neon PostgreSQL | ✅ Connected — `DATABASE_URL` in `.env` |
| Upstash Redis | ✅ Connected — `REDIS_URL` in `.env` |
| Prisma DB schema | ✅ Pushed to Neon |
| Git repo | ✅ Initialized + committed |

**You don't need to touch Neon or Upstash again.**

---

## Step 1: Push to GitHub

1. Go to [github.com/new](https://github.com/new) — create a **free** public repo named `instagram-comment-dm`
2. Run these commands in your terminal:

```bash
cd /Users/hannanmohsin/Documents/Marketing/Zauq\ e\ Zaika/Custom\ API/instagram-comment-dm
git remote add origin https://github.com/YOUR_USERNAME/instagram-comment-dm.git
git push -u origin main
```

---

## Step 2: Deploy on Render

1. Go to [render.com](https://render.com) and **sign up with GitHub** (no credit card needed)

2. Click **New +** → **Web Service**

3. **Connect your repo** → select `instagram-comment-dm`

4. Fill in the form:

   | Setting | Value |
   |---------|-------|
   | **Name** | `instagram-comment-dm` |
   | **Region** | `Singapore` (closest to you) |
   | **Branch** | `main` |
   | **Runtime** | `Node` (not Docker) |
   | **Build Command** | `npm install && npx prisma generate --schema=src/prisma/schema.prisma` |
   | **Start Command** | `node src/index.js` |
   | **Plan** | **Free** ✅ |

5. **Add Environment Variables** (click "Advanced" → "Add Environment Variable"):

   | Variable | Value |
   |----------|-------|
   | `PAGE_ACCESS_TOKEN` | *(get from Meta Graph API Explorer)* |
   | `APP_SECRET` | *(get from Facebook App Dashboard)* |
   | `VERIFY_TOKEN` | *(any string you choose)* |
   | `DATABASE_URL` | Your Neon connection string from `.env` (ends with `?sslmode=require`) |
   | `REDIS_URL` | Your Upstash Redis URL from `.env` (starts with `rediss://`) |
   | `TRIGGER_KEYWORD` | `LINK` |
   | `DM_MESSAGE_TEXT` | `Here's your link! Click below:` |
   | `DM_BUTTON_TITLE` | `Get Link` |
   | `DM_BUTTON_URL` | `https://your-link-here.com` |
   | `NODE_ENV` | `production` |

6. Click **Create Web Service**

7. Wait ~3 minutes for the build. You'll get a URL like:
   ```
   https://instagram-comment-dm.onrender.com
   ```

8. **Test it:**
   ```bash
   curl https://instagram-comment-dm.onrender.com/health
   ```
   → `{"status":"ok","service":"instagram-comment-dm"}` ✅

---

## Step 3: Keep Render awake (critical!)

Render's free tier **spins down after 15 minutes of inactivity**. When spun down, webhooks fail with timeout. Here's the free fix:

1. Go to [cron-job.org](https://cron-job.org) — sign up (free, no card)

2. Click **Create Cronjob**:

   | Setting | Value |
   |---------|-------|
   | **Title** | `Ping Instagram DM` |
   | **URL** | `https://instagram-comment-dm.onrender.com/health` |
   | **Interval** | Every **10 minutes** |
   | **Method** | `GET` |

3. Click **Create**

That's it. Your server stays awake 24/7. If cron-job.org ever goes down, Render's auto-sleep just means a 30-second delay on the first webhook — Meta retries automatically.

---

## Step 4: Configure webhook in Meta

1. Your public webhook URL is:
   ```
   https://instagram-comment-dm.onrender.com/webhook
   ```

2. Go to [developers.facebook.com](https://developers.facebook.com) → your app → **Webhooks** → **Instagram**

3. Click **Add Subscription**:

   | Field | Value |
   |-------|-------|
   | **Callback URL** | `https://instagram-comment-dm.onrender.com/webhook` |
   | **Verify Token** | *(same as your `VERIFY_TOKEN`)* |
   | **Fields** | Check `comments` |

4. Click **Verify and Save**

---

## Step 5: Get your Meta credentials (still needed)

You still need **3 values from Facebook** that I can't fill in for you:

### PAGE_ACCESS_TOKEN
1. Go to [developers.facebook.com/tools/explorer](https://developers.facebook.com/tools/explorer)
2. Select your app → **Get Page Access Token** → select your Page → grant permissions:
   - `instagram_manage_comments`
   - `instagram_manage_messages`
3. Copy the token → paste into Render's env vars

### APP_SECRET
1. Facebook App Dashboard → **Settings** → **Basic**
2. Copy **App Secret** → paste into Render's env vars

### VERIFY_TOKEN
- Make up any random string (e.g., `mySecureToken123!`) → use same value in both Render env vars AND Meta webhook setup

After adding these to Render's env vars → click **Manual Deploy** → **Deploy latest commit**.

---

## How updates work

Whenever you change the code, just:

```bash
git add .
git commit -m "your change"
git push
```

Render auto-rebuilds and redeploys. The `.env` on your local machine stays — Render uses its own env vars you set in the dashboard.

---

## Architecture

```
                         cron-job.org
                      (pings every 10min)
                            │
                            ▼
┌────────────┐  webhooks  ┌──────────────────┐
│ Meta/IG    │ ─────────► │  Render (Node)   │
│            │            │  512MB, always-on │
└────────────┘            └──────┬───────────┘
                                 │
                     ┌───────────┴───────────┐
                     │                       │
                     ▼                       ▼
              ┌────────────┐        ┌──────────────┐
              │ Neon       │        │ Upstash      │
              │ PostgreSQL │        │ Redis        │
              │ 500MB free │        │ 256MB free   │
              └────────────┘        └──────────────┘
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `prisma: command not found` in build logs | Build command needs `npx prisma generate` (not bare `prisma`) |
| Webhook returns 404 | Make sure your Meta Callback URL ends with `/webhook` |
| Webhook returns 403 | `VERIFY_TOKEN` mismatch between Render env vars and Meta |
| "Cannot connect to database" | Confirm `DATABASE_URL` has `?sslmode=require` at the end |
| DM not sending | Confirm `PAGE_ACCESS_TOKEN` has `instagram_manage_messages` permission |
| Redis connection error | Make sure `REDIS_URL` starts with `rediss://` (TLS) |
