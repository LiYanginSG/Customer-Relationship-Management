# Go live

One path, start to finish, entirely in a browser. Roughly 40 minutes.

After each stage there is a **check** — do it. A failure caught at stage 3 takes
a minute to fix; the same failure found at stage 7 looks like everything is
broken.

---

## The five values you will need

Keep this open. Two of them you invent.

| | Where it comes from | Looks like |
|---|---|---|
| **Project ref** | Supabase gives it. In your dashboard address bar: `supabase.com/dashboard/project/`**`abcdefghijklmnop`** | `abcdefghijklmnop` |
| **Bot token** | BotFather gives it (stage 3) | `8123456789:AAHf7x-KpQ...` |
| **Chat ID** | @userinfobot gives it (stage 3) | `123456789` |
| **Webhook secret** | **You invent it.** 20+ random characters | `kj38fhskd93jfks02ldk` |
| **Cron secret** | **You invent it.** A *different* 20+ characters | `p29xmv02kdl39sjfa1of` |

The last two are passwords you are *setting*, not being told. Write them down —
you will type each one twice, in different places, and they must match.

---

## Stage 1 — Supabase project

1. **supabase.com** → sign up → **New project**
2. Name it anything. Save the database password somewhere.
3. **Region: Southeast Asia (Singapore).** Keeps client data in Singapore.
4. Create, and wait ~2 minutes.

**Check:** the dashboard loads and the address bar shows your project ref.

---

## Stage 2 — The database, in one paste

1. Left sidebar → **SQL Editor** → **New query**
2. Open **`supabase/schema.sql`** from this repository
3. Select all, copy, paste, **Run**

That is the whole database — tables, views, the NRIC guard, the product search,
the CPF reference. One file, not twelve.

> Ignore the numbered files in `migrations/`. They are the history of how this
> was built. `schema.sql` is the same end state, verified to produce an
> identical database. Only use the numbered files if you have already run some.

**Check:** paste this and run it.

```sql
select
  (select count(*) from information_schema.tables where table_schema='public') as tables_and_views,
  (select count(*) from cpf_awl_limits) as cpf_rows,
  build_daily_briefing() is not null as briefing_works;
```

You want **19**, **3**, **true**. Anything else, stop — the paste was incomplete.

---

## Stage 3 — Telegram bot

1. Telegram → search **@BotFather** (blue tick) → `/newbot`
2. Give it a name, then a username ending in `bot`
3. **Copy the token.** Treat it as a password.
4. Search **@userinfobot**, press Start — it replies with your **chat ID**

**Check:** you have a token and a number written down.

---

## Stage 4 — Secrets

Open: `https://supabase.com/dashboard/project/_/functions/secrets`
(That underscore picks your project automatically.)

Or: left sidebar → **Edge Functions** → **Secrets**.

Add four:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from stage 3 |
| `TELEGRAM_ALLOWED_CHAT_IDS` | your chat ID |
| `TELEGRAM_WEBHOOK_SECRET` | the one you invented |
| `CRON_SECRET` | the other one you invented |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied automatically.
Leave `ANTHROPIC_API_KEY` out for now — everything below works without it.

**Check:** four secrets listed. They apply immediately; no redeploy needed.

---

## Stage 5 — Deploy the two functions

Left sidebar → **Edge Functions** → **Deploy a new function** → **Via Editor**.

**First function — name it exactly `telegram`:**
delete the sample code, paste all of **`dist/telegram.ts`**, **Deploy**.

**Second — name it exactly `briefing`:**
paste all of **`dist/briefing.ts`**, **Deploy**.

**Then, for each one:** open it → **Settings** → switch **Verify JWT** **off**.

> This one matters and is easy to miss. Supabase rejects any request without a
> logged-in user's token, before your code runs. Telegram is an outside service
> and cannot send one. Leave it on and your bot is silently dead.

**Check:** both functions listed, both showing Verify JWT off.

---

## Stage 6 — Connect Telegram

Paste into your browser's address bar as **one line**, with your values:

```
https://api.telegram.org/botYOUR-BOT-TOKEN/setWebhook?url=https://YOUR-PROJECT-REF.supabase.co/functions/v1/telegram&secret_token=YOUR-WEBHOOK-SECRET
```

You want `{"ok":true,...}`.

**Check:** message your bot `/status` in Telegram. It should reply with how many
clients and policies you have (zero of each, for now).

If nothing comes back, open:
`https://api.telegram.org/botYOUR-BOT-TOKEN/getWebhookInfo` and read
`last_error_message`. **401** means Verify JWT is still on — back to stage 5.

---

## Stage 7 — The 7am alarm

1. Open `supabase/migrations/0008_schedule.sql`
2. Replace **every** `YOUR-PROJECT-REF` and the one `YOUR-CRON-SECRET`
3. Paste into the SQL Editor and run

**Check:**

```sql
select jobname, schedule, active from cron.job;
```

Four jobs. Your morning briefing is set.

---

## Stage 8 — Put something in it

Easiest first test, and no client data needed:

**Send a product PDF to your bot**, with a caption naming it, like
`AIA Max VitalHealth A`. It replies with how many pages and sections it indexed.

Then try, in Telegram:

```
/library
/product deferment period
```

**Check:** `/library` lists your document, `/product` returns actual clause text
with a page number.

If the bot says it could not read useful text, that PDF is a scan rather than
text. Get the text version from the insurer's site.

---

## Stage 9 — The portal (optional)

A web app for browsing and editing, rather than chatting. Free on Vercel, same
database. Follow **[PORTAL.md](PORTAL.md)** — about 10 minutes.

You do not need it. The bot works without it.

---

## Stage 10 — The manager (optional, costs money)

Everything above is free and stays free: briefings, alerts, product search,
imports, the portal.

What you cannot do yet is *talk* to it — ask questions in plain English, or
dictate a meeting note and have it filed.

To switch that on: **console.anthropic.com** (a separate account from any Claude
subscription), add US$5, create a key, and add it as a secret named
`ANTHROPIC_API_KEY`. No redeploy needed.

The daily cap starts at **US$1.00**. Check spend with `/spend`; change the cap in
**Table Editor → app_settings**.

To turn it off: delete the secret. Back to free, nothing lost.

---

## If something is wrong

| Symptom | Cause |
|---|---|
| Bot silent | Verify JWT still on, or webhook not registered. Check `getWebhookInfo`. |
| Replies to `/id` only | Your chat ID is not in `TELEGRAM_ALLOWED_CHAT_IDS`. |
| "Could not load briefing" | `schema.sql` did not finish. Re-run the stage 2 check. |
| No morning briefing | It stays quiet when there is nothing to say. Send `/brief` to test. Then `select * from cron.job_run_details order by start_time desc limit 5;` |
| "Missing required secret" | A secret name is misspelled. They are case-sensitive. |
| Function errors | **Edge Functions** → pick it → **Logs**. |

## What it costs

| | |
|---|---|
| Supabase free tier | $0 — 500MB, far more than you need |
| Telegram | $0 |
| Briefings, alerts, commands, product search, imports, portal | $0 |
| Talking to the manager | Only with stage 10, capped daily |

The free tier pauses a project after a week of no activity. Your cron jobs count
as activity, so this will not affect you.
