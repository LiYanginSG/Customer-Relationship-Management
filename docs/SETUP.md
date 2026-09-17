# Setting this up

Written assuming you have never deployed anything before. Follow it top to
bottom. Budget about 45 minutes the first time.

You will need three free accounts: Supabase, Telegram (you already have it),
and GitHub (optional, only if you want to edit things later).

Nothing here costs money unless you choose to switch the AI on in Step 8.

---

## Step 1 — Create the Supabase project

1. Go to **supabase.com** and sign up.
2. Click **New project**.
3. Name it anything. `crm` is fine.
4. Choose a **database password** and save it somewhere. You will rarely need
   it, but you cannot recover it.
5. For **Region**, pick **Southeast Asia (Singapore)**. This keeps your client
   data in Singapore and makes everything faster.
6. Click **Create new project** and wait about two minutes.

---

## Step 2 — Build the filing cabinet

1. In the left sidebar, click **SQL Editor**.
2. Open the file `supabase/migrations/0001_core_schema.sql` from this repository.
3. Copy the whole thing, paste it into the SQL Editor, click **Run**.
4. You should see *Success. No rows returned.* That is what success looks like.
5. Repeat for each file **in order**:

   - `0001_core_schema.sql`
   - `0002_nric_guard.sql`
   - `0003_products_and_ops.sql`
   - `0004_briefing_views.sql`
   - `0005_briefing_builder.sql`
   - `0006_security.sql`
   - `0007_storage.sql`
   - `0009_search_fallback.sql`

   **Skip `0008_schedule.sql` for now.** It needs values you do not have yet.
   You will come back to it in Step 7.

> **If one fails**, stop. Do not carry on to the next. The error message says
> what went wrong, and running them out of order is the usual cause.

---

## Step 3 — Create your Telegram bot

1. Open Telegram and search for **@BotFather**. It has a blue tick.
2. Send it `/newbot`.
3. Give it a name (what you will see) — e.g. `My Practice Manager`.
4. Give it a username, which must end in `bot` — e.g. `weiming_practice_bot`.
5. BotFather replies with a **token** that looks like
   `8123456789:AAHf7x-KpQ2mZ...`

**Keep that token private.** Anyone holding it controls your bot.

---

## Step 4 — Find your chat ID

The bot needs to know that you are you, so that nobody else can message it and
ask about your clients.

1. Search for your new bot in Telegram and press **Start**.
2. Nothing will happen yet. That is expected — the bot is not connected.
3. To get your ID, message **@userinfobot** instead. It replies with your ID,
   a number like `123456789`.

Write it down.

---

## Step 5 — Put the secrets into Supabase

This page has moved around over the years. As of now it is **not** under
Project Settings.

**Easiest:** open this link, which picks your project automatically:

> https://supabase.com/dashboard/project/_/functions/secrets

**Or navigate:** **Edge Functions** in the left sidebar — the `ƒ` icon, near the
bottom — then the **Secrets** tab.

Add each of these with **Add new secret**:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The token from Step 3 |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Your chat ID from Step 4 |
| `TELEGRAM_WEBHOOK_SECRET` | Make one up. 20+ random characters. |
| `CRON_SECRET` | Make up a different one. 20+ random characters. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically —
you do not add those.

> **If you cannot find the page at all**, skip the dashboard and use the
> terminal instead. This works regardless of what Supabase have renamed
> things to, and you will need the terminal for Step 6 anyway:
>
> ```bash
> supabase secrets set TELEGRAM_BOT_TOKEN=paste-your-token-here
> supabase secrets set TELEGRAM_ALLOWED_CHAT_IDS=123456789
> supabase secrets set TELEGRAM_WEBHOOK_SECRET=your-random-string
> supabase secrets set CRON_SECRET=your-other-random-string
>
> # Check they all landed
> supabase secrets list
> ```
>
> Run `supabase login` and `supabase link` from Step 6 first.

Secrets take effect immediately. You do not need to redeploy after adding or
changing one.

> **Why two made-up secrets?** They prove that a request really came from
> Telegram, and really came from your scheduler. Without them, anyone who
> guessed your function's web address could trigger messages to your phone.

---

## Step 6 — Deploy the functions

Two routes. **Route A needs no terminal at all** — pick that one if Step 6 was
where you stopped.

---

### Route A — from your browser (no terminal, works on any computer)

The repository contains two ready-made single files, already assembled for
exactly this. You copy and paste them.

1. In Supabase, click **Edge Functions** in the left sidebar.
2. Click **Deploy a new function** → **Via Editor**.
3. Name it exactly **`telegram`**. The name matters — it becomes part of the
   web address Telegram will call.
4. Delete whatever sample code is in the editor.
5. Open **`dist/telegram.ts`** from this repository, select all, copy, and paste
   it into the editor.
6. Click **Deploy function**. It takes 10–30 seconds.

Now repeat for the second one:

7. **Deploy a new function** → **Via Editor**, name it exactly **`briefing`**.
8. Paste in **`dist/briefing.ts`**. Deploy.

**Then turn off JWT verification for both.** This matters and is easy to miss.
By default Supabase rejects any request that does not carry a logged-in user's
token. Telegram cannot send one — it is an outside service, not a user. Leave
this on and your bot will simply never respond.

Open each function → **Settings** → look for **Verify JWT** (sometimes
*Enforce JWT verification*) and switch it **off**. Do it for both.

> **Two things to know about Route A.** The dashboard editor keeps no version
> history, so treat the pasted code as disposable — the real source lives in
> this repository. And if you ever change the code, re-run the bundler
> (`python3 scripts/bundle.py`) and paste the fresh file.

---

### Route B — from a terminal

Use this if you are comfortable with a command line, or want proper version
control over deployments.

**Do not use `npm install -g supabase`.** Supabase does not support installing
their CLI that way and it will fail.

**On Windows**, open **PowerShell** and use [Scoop](https://scoop.sh):

```powershell
# Install Scoop itself, if you do not have it
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression

# Then the Supabase CLI
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

**On a Mac**, open **Terminal**:

```bash
brew install supabase/tap/supabase
```

**On either**, if you already have Node and would rather not install anything:

```bash
npx supabase --version
```
...then prefix every command below with `npx`.

Once installed:

```bash
supabase login          # opens your browser

# Your project ref is in the Supabase address bar:
# supabase.com/dashboard/project/THIS-BIT-HERE
supabase link --project-ref YOUR-PROJECT-REF

supabase functions deploy telegram
supabase functions deploy briefing
```

You do **not** need `--no-verify-jwt` — `supabase/config.toml` in this
repository already sets `verify_jwt = false` for both functions, and the CLI
reads it.

---

## Step 7 — Connect Telegram, and switch the alarm clock on

**Connect the bot.** This tells Telegram where to send your messages.

*No terminal?* Paste this straight into your browser's address bar, with your
own values swapped in, and press Enter:

> `https://api.telegram.org/botYOUR-BOT-TOKEN/setWebhook?url=https://YOUR-PROJECT-REF.supabase.co/functions/v1/telegram&secret_token=YOUR-TELEGRAM-WEBHOOK-SECRET`

You should see `{"ok":true,...}`. Skip to **Test it** below.

*Or from a terminal*, replacing the three capitalised parts:

```bash
curl -X POST "https://api.telegram.org/botYOUR-BOT-TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR-PROJECT-REF.supabase.co/functions/v1/telegram",
    "secret_token": "YOUR-TELEGRAM-WEBHOOK-SECRET"
  }'
```

You should see `{"ok":true,"result":true,...}`.

**Test it.** Message your bot `/status` in Telegram. It should reply.

If it does, you are live.

**Now the schedule.** Open `supabase/migrations/0008_schedule.sql`, and replace:

- every `YOUR-PROJECT-REF` with your project ref
- `YOUR-CRON-SECRET` with the `CRON_SECRET` from Step 5

Then paste the whole file into the SQL Editor and run it.

Check it worked:

```sql
select jobname, schedule, active from cron.job;
```

You should see four jobs. Your 7am briefing is now set.

---

## Step 8 — (Optional) Wake the manager up

Everything so far is free and stays free. Commands work, the morning briefing
arrives, birthdays and premiums are tracked.

What you *cannot* do yet is talk to it in plain English, or dictate a meeting
note and have it filed.

To switch that on:

1. Go to **console.anthropic.com** — this is a **separate account** from your
   Claude subscription, and is billed separately.
2. Add US$5 of credit.
3. Create an API key.
4. Add it as a secret named `ANTHROPIC_API_KEY`, the same way as Step 5.

That is all — no redeploy needed. Message the bot `/status` and it should now
say the manager is awake. (If it still says asleep, give it a minute for the
running instance to cycle, then try again.)

**To turn it off again**, delete the secret. You are back to free, and nothing
is lost — your clients, policies and notes are all still there, and every
scheduled alert carries on as normal.

### Controlling the spend

The daily cap defaults to **US$1.00**. When a day's usage reaches it, the
manager stops answering and tells you so. Scheduled briefings are unaffected —
they cost nothing.

To change it, go to **Table Editor → app_settings** and edit
`daily_spend_cap_usd`. Check any time with `/spend`.

---

## Step 9 — Put your clients in

Three ways, use whichever suits:

**A spreadsheet.** Export from your company portal, then just attach the file
to a Telegram message. The bot reads it, tells you what it found, and waits for
you to confirm before saving anything. Re-import monthly — it updates rather
than duplicates.

**By hand.** Supabase **Table Editor → clients → Insert row**. Fine for a
handful.

**By talking** (needs Step 8). "Add Sarah Lim, born 28 Dec 1988, PR, married,
two kids."

### Product documents

Attach a PDF to a Telegram message. Add a caption naming it, like
`AIA Max VitalHealth A`. The bot extracts the text, indexes it, and the product
desk can then quote from it.

Scanned documents will not work — those are pictures of text, which needs OCR.
Download the text version from the insurer's site instead.

---

## Troubleshooting

**The bot does not reply at all.**
Open this in your browser, with your token pasted in:

> `https://api.telegram.org/botYOUR-BOT-TOKEN/getWebhookInfo`

Read `last_error_message`. It usually says exactly what is wrong.

If it mentions **401** or **Unauthorized**, JWT verification is still on.
Go to **Edge Functions → telegram → Settings** and switch **Verify JWT** off.
This is the single most common reason a freshly deployed bot stays silent.

**It replies to `/id` but nothing else.**
Your chat ID is not in `TELEGRAM_ALLOWED_CHAT_IDS`. Add it — no redeploy
needed — and message the bot again.

**No morning briefing arrived.**
First, it may have had nothing to say — that is deliberate, it stays quiet
rather than sending "nothing today" every morning. Send `/brief` to check it
works. Then look at the schedule:
```sql
select * from cron.job_run_details order by start_time desc limit 10;
```

**"Missing required secret".**
A secret name is misspelled in Step 5. They are case-sensitive.

**Seeing function errors.**
Supabase → **Edge Functions** → pick the function → **Logs**.

---

## What it costs

| | Cost |
|---|---|
| Supabase free tier | $0 — 500MB database, plenty for tens of thousands of policies |
| Telegram | $0 |
| Scheduled briefings, all commands | $0 — plain database queries |
| Conversation and note-filing | Only if you do Step 8. Capped at your daily limit. |

The Supabase free tier pauses a project after a week of no activity. Your cron
jobs count as activity, so this will not affect you.
