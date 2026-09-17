# Practice Manager

A back office for a Singapore financial services consultant. You talk to one
manager on Telegram; the manager runs five specialist desks behind the scenes.

```
                     You, on Telegram
                            │
                    ┌───────▼────────┐
                    │    MANAGER     │  the only one you talk to
                    └───────┬────────┘
        ┌──────────┬────────┼─────────┬──────────┐
        ▼          ▼        ▼         ▼          ▼
   Birthdays   Policies   Who to    Relation-  Product
   & milestones & premiums  see     ship        knowledge
        └──────────┴────────┼─────────┴──────────┘
                            ▼
                  Supabase (Postgres + files)
```

You never pick a desk. You say "brief me on Sarah before my 2pm" and the
manager works out that it needs the relationship desk and the policy desk, asks
both, and answers you in one voice.

**New here? Go to [docs/SETUP.md](docs/SETUP.md).** It can be set up entirely
from a browser — no terminal, no Mac, nothing to install.

**Want a screen to work in rather than a chat?** There is an admin portal too:
client list, policy cards, meeting timeline, follow-ups. Free on Vercel, same
database as the bot. See **[docs/PORTAL.md](docs/PORTAL.md)**.

---

## It runs free, and gets smarter if you pay

This is built to be useful with **no AI key at all**.

| | Free, no key | With an API key |
|---|---|---|
| 7am briefing | ✅ | ✅ |
| Birthday & milestone alerts | ✅ | ✅ |
| Premium due & overdue warnings | ✅ | ✅ |
| Policy anniversaries | ✅ | ✅ |
| Who's gone quiet | ✅ | ✅ |
| Spreadsheet import | ✅ | ✅ |
| Commands (`/brief`, `/due`, …) | ✅ | ✅ |
| **Asking questions in plain English** | ❌ | ✅ |
| **Dictating a meeting note to be filed** | ❌ | ✅ |
| **Product questions answered from contracts** | ❌ | ✅ |

The scheduled half is plain SQL — no model is called, so it cannot cost money
and cannot break when someone's API is down. Adding `ANTHROPIC_API_KEY` wakes
the manager and the five desks. Removing it puts them back to sleep. Nothing
is lost either way.

> Your Claude subscription and an Anthropic API key are **separate products
> with separate bills**. The subscription is for you, logged in. The key is for
> this bot, running at 7am when you are asleep.

---

## What it does

**Tells you things, unprompted**

> ☀️ **Morning briefing** · Wed, 16 Sept
>
> 🔴 **Premiums overdue — lapse risk**
> • **Sarah** — Great Eastern GREAT Term, $1,200 — **6 days late**
>
> ✅ **You promised**
> • Wei Ming: Send Shield plan comparison **(5 days overdue)**
>
> 🎂 **Birthdays**
> • Wei Ming — turns 41 Sat, 19 Sept (in 3 days)
>    *no contact in 200 days*
> • Anya — Sarah Lim's child — turns 6 Mon, 21 Sept (in 5 days)

**Answers what you ask** *(needs a key)*

> **You:** who should I see this week?
>
> **Manager:** Three worth your time. Sarah Lim first — her GREAT Term premium
> is six days late and that is a lapse risk, not a reminder. Wei Ming, because
> it is his birthday Saturday and you have not spoken in 200 days, and you still
> owe him the Shield comparison. Jason Koh is 310 days past his own review
> cadence.

**Files what you tell it** *(needs a key)*

> **You:** just saw Mr Tan. wife expecting march, worried about SA top-up
>
> **Manager:** Filed against Wei Ming. Added his wife's due date and set two
> follow-ups — newborn cover in February, SA top-up before year end for the
> tax relief.

---

## Design decisions worth knowing

**No NRIC, anywhere.** Enforced twice: a database trigger strips NRIC and FIN
numbers on write, and every path out of the system scrubs again before text
reaches the model or your phone. Even an import file full of them stores none.

**The free half is plain SQL.** The morning briefing is one database function.
The thing you rely on daily has no bill, no API dependency, and no model that
can hallucinate a premium amount.

**Ranking is computed, not guessed.** "Who should I see" scores real signals —
overdue premiums, broken promises, silence against each client's own cadence —
in code. You can audit why someone is at the top. The model explains the
ranking; it does not invent it.

**Read desks cannot write.** The five desks hold only lookup tools. Every tool
that changes your records sits with the manager. A confused lookup agent cannot
alter your client book.

**Imports are staged.** A spreadsheet is parsed, summarised, and shown to you.
Nothing is saved until you reply `/apply`. Updates fill blanks rather than
overwrite — a portal export will not clobber a phone number you fixed by hand.

**It stays quiet when there is nothing to say.** No "nothing today" message
every morning. A bot you mute is useless on the day something matters.

**Portal exports stay manual.** The bot will never log into your principal's
portal. Those are your credentials and your agency's IT rules. It reminds you
monthly to do the export yourself.

---

## Layout

```
supabase/
  migrations/           run these in order — see docs/SETUP.md
    0001_core_schema        clients, family, policies, interactions, opportunities
    0002_nric_guard         the NRIC triggers
    0003_products_and_ops   product library, spend ledger, import staging
    0004_briefing_views     the free deterministic views
    0005_briefing_builder   the whole briefing in one SQL call
    0006_security           RLS deny-by-default
    0007_storage            private buckets
    0008_schedule           pg_cron — needs your values filled in
    0009_search_fallback    forgiving product search
  functions/
    _shared/
      config.ts         secrets; decides whether the AI is awake
      claude.ts         model wrapper, spend cap, tool loop
      manager.ts        the manager and their delegate tools
      staff/
        index.ts        the five desks and their briefs
        tools.ts        every database tool, scoped per desk
      briefing.ts       formats the morning message
      ingest.ts         spreadsheet and PDF handling
      nric.ts           NRIC scrubbing
      telegram.ts       sending, splitting, file download
      db.ts, dates.ts
    telegram/           the webhook
    briefing/           the scheduled push
dist/                   generated single-file builds, for pasting into the
                        Supabase dashboard editor -- do not edit by hand
scripts/bundle.py       regenerates dist/ after any source change
tests/                  deno test --allow-env --allow-read tests/

admin/                  the web portal (Next.js, deploys to Vercel)
  app/                  Today, Clients, client detail, login, auth callback
  components/           forms and cards
  lib/
    auth.ts             magic-link session + email allowlist
    db.ts               service-role client, "server-only" so it cannot leak
    actions.ts          every write, each re-checking auth first
    format.ts           Singapore dates, money, and the dropdown vocabularies
```

### Deploying without a terminal

`dist/telegram.ts` and `dist/briefing.ts` are the whole of each function
flattened into one file, with `npm:` and `jsr:` imports left intact. Paste
either into Supabase's browser-based function editor and deploy. Regenerate
them after changing anything under `supabase/functions/`:

```bash
python3 scripts/bundle.py
deno check dist/telegram.ts dist/briefing.ts   # always verify the output
```

(`deno bundle` would also work, but it inlines the npm packages and produces a
4.8MB file no browser editor will take. The script only flattens local modules,
giving ~115KB.)

## Commands

| | |
|---|---|
| `/brief` | today's briefing on demand |
| `/week` | the week ahead |
| `/due` | premiums due and overdue |
| `/birthdays` | the next fortnight |
| `/quiet` | who has gone cold |
| `/apply <ref>` | confirm a staged spreadsheet import |
| `/spend` | today's AI cost against the cap |
| `/status` | what is switched on |
| `/id` | this chat's ID |

## Developing

```bash
deno check supabase/functions/telegram/index.ts supabase/functions/briefing/index.ts
deno test --allow-env --allow-read tests/
deno lint supabase/functions/

python3 scripts/bundle.py                      # refresh dist/
deno check dist/telegram.ts dist/briefing.ts   # and check what it produced
```

Both functions run with `verify_jwt = false` (set in `supabase/config.toml`).
That is deliberate and is Supabase's documented pattern for signed webhooks:
neither Telegram nor `pg_cron` can present a user JWT, so each function
authenticates its caller itself against a shared secret and returns 403
otherwise.

## Scope

This is back-office support for a licensed representative. It surfaces facts,
gaps and timing. It does not recommend products or assess suitability — that is
your licence and your judgement, and the manager is instructed to stay on the
correct side of that line.
