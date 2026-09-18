# The product library

Where product summaries and policy contracts live, and how to ask questions of
them.

This is a good place to start, before any client data. Product documents
contain no personal information, so there is nothing to be careful about.

## Before any of this works

The product library needs two things running: the database migrations applied,
and the `telegram` function deployed. Until both are done there is no bucket
for a file to land in and no bot to receive it — a PDF sent to an undeployed
bot simply goes nowhere, with no error.

See [SETUP.md](SETUP.md) steps 1-2 (migrations) and 5-7 (bot). You can skip the
cron schedule in step 7 if you only want the product library for now.

## Where they go

**Supabase Storage, in a private `products` bucket.** Private means no public
URL and no shareable link — the file is readable only by your own functions.

You never touch the bucket directly. Send the PDF to your Telegram bot and it
stores the file, extracts the text, splits it into searchable sections, and
indexes it.

## How to send one

Attach the PDF to a Telegram message **with a caption naming it**:

> `AIA Max VitalHealth A`

The caption matters. The first word becomes the insurer, and the whole caption
becomes the product name — that is how you will find it later. Without a
caption it falls back to the filename, which is usually something like
`AIA_MVH_A_PS_v3_final.pdf` and helps nobody.

The bot replies with how many pages and sections it indexed.

## Asking questions

### Free, no API key

**Type these to your bot in Telegram** — not in a terminal, and not in a Claude
chat. They are commands your bot understands, and they only work once the bot
is deployed and the migrations are run.

```
/library                              what is uploaded
/product deferment period             search the contracts
/product pre-existing exclusion
/product annual claim limit
```

This runs a real full-text search and returns the **actual wording**, with the
document and page it came from. It is not a summary and not an interpretation —
it is the clause.

For most of what you need a product document for, that is the better answer
anyway. If a client asks about a waiting period, the sentence you have to be
right about is the one in the contract, not a paraphrase of it.

A result marked *loose match* means not every search term was found, so read it
before relying on it.

### With an API key

Ask in plain English and the product desk answers:

> **You:** does Max VitalHealth cover pre-existing conditions if declared?
>
> **Manager:** Only if declared in the application and accepted in writing. The
> contract also treats a condition as pre-existing where symptoms existed that
> would have caused a reasonable person to seek diagnosis — so undiagnosed but
> symptomatic counts. That is section "Pre-existing Conditions", page 14 of the
> policy contract.

The desk is instructed to answer **only** from what the search returns, to name
the document, and to say plainly when the library does not contain the answer.
Product terms differ between insurers and change between versions, so a
confident guess about an exclusion is exactly the kind of thing that becomes a
complaint.

## What to upload, in order of usefulness

1. **Policy contracts.** Longest and least pleasant to read, which is precisely
   why having them searchable pays off. This is where exclusions, definitions
   and waiting periods live — the questions that actually come up.
2. **Product summaries.** The benefit tables. Short and high value.
3. **Rate tables.** Useful for premium questions.
4. **Benefit illustrations.** Least useful here — they are client-specific
   rather than product-level.

## Two limits worth knowing

**Scanned documents will not work.** If the PDF is images of pages rather than
text, there is nothing to extract. The bot tells you rather than storing an
empty document. Download the text version from the insurer's site instead.

**Superseded versions.** When a product is revised, upload the new document and
mark the old one `superseded` in Supabase (Table Editor → products → status).
Search only covers `current` documents, so an old exclusion cannot surface as
if it still applied.

## Housekeeping

These are your principal's documents, held privately for your own reference.
The bucket is not public and nothing generates a shareable link. Keep it that
way.
