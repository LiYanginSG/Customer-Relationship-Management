# Adapting this to your actual export

The schema is a considered guess at what a Singapore adviser's book looks like.
It will be wrong in places — every principal names things differently and
carries fields nobody else does. This is how to fix that without losing
anything.

## The short version

Nothing you import is ever thrown away. A column the importer does not
recognise is kept anyway, stored against the record and shown on the client
page under **From your export**. So you can import first and adapt later.

## What to send Claude

**You do not need to send client data.** Column *names* are enough to do the
work. In order of preference:

**1. Just the header row.** Open the export, copy the first row, paste it.
No client information leaves your machine at all. This is all that is
genuinely needed.

**2. The bot's own report.** Send the export to your Telegram bot. It replies
with which columns it recognised and which it did not. Screenshot or copy that
list. Your data stays in your own Supabase.

**3. If a format is ambiguous**, two or three rows with **made-up** values —
so dates, premium modes and statuses can be read correctly. Invent the names.
`Tan Ah Kow, 03/04/1985, Monthly, IN-FORCE` tells Claude everything needed.

Also worth saying:

- Which columns you actually care about, and which are noise.
- Whether your portal gives separate reports (clients, policies, commissions)
  or one combined sheet.

## What changes as a result

- **A new migration** adding the columns that earned a place. Additive, so
  existing records are untouched.
- **The importer's alias list** extended, so your exact column spellings map
  automatically on every future import.
- **The portal** gains the fields — on the forms, the client page, and the
  policy cards where they belong.
- **A backfill**, if you have already imported: anything sitting in `extra`
  gets moved into its proper new column, so you do not re-import.
- **The dropdown vocabularies** extended if your principal uses statuses or
  policy types not already covered.

## The order that saves you work

1. Pull the export.
2. Send the header row.
3. Schema and portal adapted.
4. *Then* import.

That way everything lands in the right column first time. Importing before
adapting still works — nothing is lost — but you end up reviewing what landed
in `extra` afterwards.

## Do not automate the portal login

Worth repeating: do the export yourself. Those are your principal's
credentials, and agency IT rules almost universally forbid automated access.
The value here is in what happens *after* the export, and that part is
automated already.
