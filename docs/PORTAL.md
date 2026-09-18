# The admin portal

A web app for browsing and editing your client book. Free to host on Vercel.

It reads and writes the **same database** as your Telegram bot. Add a policy
here and tomorrow's 7am briefing knows about it. File a note in Telegram and it
appears in the client's timeline here. There is one set of records, two ways in.

You do not need the AI switched on for any of this. The portal is plain
database work.

---

## Before you start

You need Step 1 and Step 2 of `SETUP.md` finished — a Supabase project with the
migrations run. The portal will not work without them.

You also need a **GitHub account**, because that is how Vercel gets the code.
Free, and you probably want the repo anyway.

---

## Step A — Create the login account

Nobody can sign up through the portal. That is deliberate: it is your client
book, not a service. You create the one account by hand.

1. Supabase → **Authentication** → **Users** → **Add user** → **Create new user**
2. Enter your email address.
3. Tick **Auto Confirm User**. (Without this, Supabase waits for a confirmation
   you will never receive.)
4. Create.

The password does not matter — you will sign in with an emailed link.

---

## Step B — Deploy to Vercel

1. Go to **vercel.com** and sign in **with GitHub**.
2. **Add New** → **Project**, and pick this repository.
3. **This is the step people miss:** set **Root Directory** to `admin`. Click
   *Edit* next to Root Directory and choose the `admin` folder. The repository
   root is the Telegram bot; the portal lives one level down.
4. Framework Preset should say **Next.js** on its own. If it does not, the root
   directory is wrong.
5. Expand **Environment Variables** and add these four:

| Name | Value | Where to find it | Type |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase → Project Settings → API | Config |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | a long `eyJ...` string | Same page, the **anon** / **publishable** key | Config |
| `SUPABASE_SERVICE_ROLE_KEY` | another long string | Same page, the **service_role** key — reveal it first | **Secret** |
| `ADMIN_ALLOWED_EMAILS` | `you@example.com` | Your own email, the one from Step A | Config |

> ### Vercel will warn you about the two `NEXT_PUBLIC_` ones
>
> *"Remove the public framework prefix to keep this value private."*
>
> **Keep the prefix on both, and set them to Config.** The warning is Vercel
> checking you meant it. You did.
>
> That prefix is not Vercel's idea — it is how Next.js decides what the browser
> is allowed to see. **Remove it and the sign-in page stops working**, because
> the login form runs in the browser and would find nothing there.
>
> Both are safe to expose:
>
> - The **URL** is just your project's address. Every network request the
>   browser makes reveals it anyway.
> - The **anon key** is designed to be public — Supabase calls it the
>   *publishable* key. It is safe here because migration `0006_security.sql`
>   enables row-level security on every table with no policies at all, and
>   revokes the `anon` role's grants. That key can read nothing: no clients, no
>   policies, no notes. It is a doorbell, not a key.
>
> The one that genuinely must never carry the prefix is
> `SUPABASE_SERVICE_ROLE_KEY`. Mark it **Secret**, which makes it write-only —
> even you cannot read it back afterwards, which is the point.

6. **Deploy.** Two minutes or so.

Vercel gives you an address like `crm-admin-abc123.vercel.app`. Copy it.

> **On the service_role key.** It bypasses every security rule in your database.
> It is only ever read on the server — the code that touches it imports
> `server-only`, so the build *fails* rather than letting it reach a browser. I
> check this on every build. Still: never paste it anywhere else.

---

## Step C — Tell Supabase to trust your portal

Sign-in links will bounce until you do this.

1. Supabase → **Authentication** → **URL Configuration**
2. **Site URL**: your Vercel address, e.g. `https://crm-admin-abc123.vercel.app`
3. **Redirect URLs**: add `https://crm-admin-abc123.vercel.app/**`

The `/**` matters — it permits the callback path the sign-in link uses.

---

## Step D — Sign in

Open your Vercel address. Enter your email. Check your inbox and click the link.

You should land on **Today**.

---

## What is on each screen

**Today** — the same briefing your bot sends at 7am, built from the same
database function, so the two can never disagree. Overdue premiums first,
then promises you have not kept, then premiums due, birthdays, anniversaries,
and who has gone quiet. Everything is clickable.

**Clients** — searchable list. The *last contact* column turns amber when
someone is past the cadence you set for them, and red if you have never
recorded contact at all.

**Library** — your product documents, grouped by insurer. Open the original
PDF, fix an insurer the importer guessed wrong, mark an old version superseded
so it stops appearing in searches, or delete it outright. Searching here
returns the actual clause text with its page number.

**A client** — everything in one page:

- Four numbers at the top: policies in force, annualised premium, total death
  cover, days since you last spoke.
- **Policies**, each showing sum assured, premium, dates, and flags for
  *premium overdue*, *CPF-funded* and *never reviewed*. Click Edit to change one.
- **File a note** — the fastest way in. One line about what was discussed,
  and it saves. Filing a note automatically updates "last contacted", which is
  what keeps them off the gone-quiet list.
- **Timeline** — every past conversation. Notes filed by the Telegram manager
  are marked *via manager*, so you can always tell machine-written recollection
  from your own words.
- **Open follow-ups** — click the box to mark one done.
- **Family** — a dependant with no cover recorded is flagged, because that is
  usually a real gap.

---

## Security, plainly

Your entire client book is on a public web address, so this is worth
understanding rather than trusting.

**Getting in** requires two things: proving you own an email address via a
one-time link, *and* that address being listed in `ADMIN_ALLOWED_EMAILS`.
Anyone can ask Supabase for a magic link. Only a listed address gets past the
callback. An empty allowlist admits nobody — a misconfigured deploy is useless
rather than open.

**Every page and every save re-checks** who you are. Not just the middleware —
a Server Action is a public endpoint whether or not a button points at it, so
each one verifies the session itself before touching data.

**The privileged key never reaches your browser.** Verified mechanically on
every build, not just intended.

**The portal is marked no-index**, so it cannot turn up in a search engine.

**NRICs are refused here too.** Type one into any field and the save is
rejected with an explanation. The database would strip it anyway; this way you
find out immediately.

### What this does not protect against

Someone with access to your email inbox can request a sign-in link and get in.
Put a passcode on your phone and two-factor on your email — that is the real
perimeter.

---

## Changing it later

```bash
cd admin
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run build
```

Copy `.env.example` to `.env.local` and fill it in first.

Push to your branch and Vercel redeploys on its own.

---

## When something is wrong

**"Could not load your briefing"** — the migrations are not all applied. Check
`0005_briefing_builder.sql` ran.

**The sign-in link goes to localhost** — Site URL in Step C is unset or wrong.

**"That email address is not permitted"** — the address is not in
`ADMIN_ALLOWED_EMAILS`, or you changed it without redeploying. Vercel needs a
redeploy after an environment variable change: **Deployments** → latest → **⋯**
→ **Redeploy**.

**"Otp is disabled" or no email arrives** — the user does not exist in Supabase.
Go back to Step A. The portal never creates accounts.

**Build failed on Vercel** — almost always Root Directory not set to `admin`.

**"This portal is not configured" on the login page** — one of the two
`NEXT_PUBLIC_` variables is missing, or its prefix was removed. Next.js only
exposes variables with that exact prefix to the browser. Restore it, then
redeploy — environment variable changes do not apply to an existing deployment.
