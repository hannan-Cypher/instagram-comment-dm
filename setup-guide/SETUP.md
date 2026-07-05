# Instagram Comment-to-DM — Account Setup Guide

This guide walks through the **Meta Developer Portal** configuration required to connect this app to your Instagram account.

---

## Prerequisites Checklist

- [ ] An **Instagram Business or Creator account** (settings → account type)
- [ ] A **Facebook Page** linked to that Instagram account
- [ ] A **Facebook Developer account** (developers.facebook.com)

---

## Step 1: Create / Configure a Facebook App

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
2. Click **Create App** → choose **Business** (not Consumer)
3. Give it a name and fill in the contact email
4. Once created, go to **Settings → Basic** and note:
   - **App ID**
   - **App Secret** (click Show) → this goes into `APP_SECRET` in `.env`

---

## Step 2: Link Your Instagram Account to a Facebook Page

Your Instagram account MUST be a **Professional account** (Business or Creator) linked to a Facebook Page.

### To link:
1. Open **Instagram app** → **Settings** → **Account** → **Linked accounts** → **Facebook**
2. Link to your Facebook Page (not your personal profile)
3. Verify it worked: open **Facebook Page settings** → **Instagram** → it should show your Instagram account

---

## Step 3: Get a Page Access Token

1. In your Facebook App dashboard, go to **Tools** → **Graph API Explorer**
2. Select your **Facebook App** (top right)
3. Select **Page Access Token** as the token type
4. Click the **Generate Access Token** button — grant these permissions:
   - `pages_show_list`
   - `pages_read_engagement`
   - `instagram_basic`
   - `instagram_manage_comments`
   - `instagram_manage_messages`
   - `pages_manage_metadata`
5. After granting, click the dropdown next to the token and select your **Facebook Page**
6. Click "i" info icon → **Open in Access Token Tool** → copy the token
   - OR simply click **Extend Access Token** to make it long-lived (60 days)
7. This token goes into `PAGE_ACCESS_TOKEN` in `.env`

### Getting a never-expiring token (optional):
- Go to **Graph API Explorer** → generate a 60-day token
- Exchange it via the `/me/accounts` endpoint for a **Page-level token** that doesn't expire (unless revoked)

---

## Step 4: Subscribe to Instagram Webhooks

1. In your Facebook App dashboard, go to **Products** → **Webhooks**
2. Click **Add Subscription** → select **Instagram**
3. Set:
   - **Callback URL**: `https://your-public-url.com/webhook`
     - During development, use **ngrok** (see below)
   - **Verify Token**: any string you choose → goes into `VERIFY_TOKEN` in `.env`
   - **Fields to subscribe**: check `comments`
4. Click **Verify and Save** — Meta sends a GET to your server. If the server is running and `VERIFY_TOKEN` matches, the handshake succeeds.

### Using ngrok for local development:
```bash
npm install -g ngrok
ngrok http 3000
# Copy the https://xxxx.ngrok.io URL → use as Callback URL
```

---

## Step 5: Add Permissions for App Review (if going live)

In development mode, the webhooks work for app admins/testers only. For production:

1. Go to **App Review** → **Permissions and Features**
2. Request **Advanced Access** for:
   - `instagram_manage_comments`
   - `instagram_manage_messages`
3. Provide demonstration videos / screenshots of your use case
4. Approval takes 1–14 days

---

## Step 6: Configure the .env file

```
PAGE_ACCESS_TOKEN=<from Step 3>
APP_SECRET=<from Step 1>
VERIFY_TOKEN=<any string you choose>
DATABASE_URL=postgresql://iguser:igpass@localhost:5432/instagram_comment_dm
REDIS_URL=redis://localhost:6379
TRIGGER_KEYWORD=DM
DM_MESSAGE_TEXT=Hey! Thanks for reaching out.
DM_BUTTON_TITLE=Get Link
DM_BUTTON_URL=https://your-link.com
```

> `DM_BUTTON_TITLE` and `DM_BUTTON_URL` are **optional**. If set, the DM includes a clickable button. If unset, only plain text is sent.

---

## Step 7: Start the server

```bash
docker compose up -d    # PostgreSQL + Redis
npm run db:push         # Create database tables
npm run dev             # Start the server
```

---

## Testing

1. Post a Reel or photo from your Instagram account
2. From a **different Instagram account**, comment the trigger keyword (e.g., "DM")
3. Watch the webhook logs — you should see:
   ```
   Webhook processed — 1 processed, 0 ignored
   Worker processing DM send job — attempt 1
   DM sent successfully
   ```
4. The commenter should receive a DM

---

## Troubleshooting

| Symptom | Likely Cause |
|---------|-------------|
| Webhook GET returns 403 | `VERIFY_TOKEN` mismatch between `.env` and Meta Developer Portal |
| Webhook POST returns 403 | `APP_SECRET` is wrong in `.env` |
| Comments received but no DM sent | `TRIGGER_KEYWORD` case mismatch, or `PAGE_ACCESS_TOKEN` lacks `instagram_manage_messages` |
| Meta API returns 551 (user unreachable) | Commenter has a private account or 24h window expired |
| Meta API returns 368 (rate limited) | You've hit 200 DMs this hour — jobs will queue for next window |
| Token expired after 60 days | Generate a new Page Access Token |

---

## Architecture Diagram

```
┌─────────────┐     Webhook POST     ┌───────────────┐
│  Meta/IG    │ ──────────────────►  │  Your Server  │
│  Servers    │     /webhook         │   :3000       │
└─────────────┘                      └───────┬───────┘
                                             │
                                   ┌─────────▼────────┐
                                   │  Verify signature │
                                   │  Check keyword    │
                                   │  DB idempotency   │
                                   │  Enqueue BullMQ   │
                                   └─────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  BullMQ Queue   │
                                    │  (200/hr limit) │
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Worker sends   │
                                    │  DM via API     │
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Commenter gets │
                                    │  DM with button │
                                    └─────────────────┘
```
