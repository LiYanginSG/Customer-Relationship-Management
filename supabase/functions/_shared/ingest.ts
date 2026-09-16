/**
 * ingest.ts -- taking in files.
 *
 * Two kinds arrive by Telegram:
 *   - A spreadsheet export from the company portal (.csv / .xlsx). Parsed,
 *     staged, and shown to you BEFORE anything touches your client list.
 *   - A product document (.pdf / .txt / .md). Stored, split and indexed so the
 *     product desk can quote from it.
 *
 * The staging step matters. A bad import that silently overwrites two hundred
 * client records is much worse than one that asks a question first.
 */

import * as XLSX from "npm:xlsx@0.18.5";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";

import { db } from "./db.ts";
import { downloadFile, sendMessage, esc, type TelegramDocument } from "./telegram.ts";
import { scrubNric } from "./nric.ts";

// ---------------------------------------------------------------------------
// Column mapping
//
// Portal exports name their columns differently at every insurer, so rather
// than demanding one exact format, we recognise the common spellings. Anything
// unrecognised is reported back to you rather than silently dropped.
// ---------------------------------------------------------------------------

const COLUMN_ALIASES: Record<string, string[]> = {
  full_name: [
    "name", "client name", "clientname", "insured name", "policyholder",
    "policy holder", "owner name", "life assured", "full name", "customer name",
  ],
  dob: ["dob", "date of birth", "birth date", "birthdate", "d.o.b"],
  gender: ["gender", "sex"],
  phone: ["phone", "mobile", "contact", "contact no", "handphone", "hp", "tel"],
  email: ["email", "e-mail", "email address"],
  occupation: ["occupation", "job", "job title", "profession"],
  insurer: ["insurer", "company", "carrier", "principal", "provider"],
  plan_name: ["plan", "plan name", "product", "product name", "policy name", "basic plan"],
  policy_number: ["policy number", "policy no", "policy no.", "policyno", "contract number", "cert no"],
  policy_type: ["type", "policy type", "product type", "category"],
  status: ["status", "policy status", "contract status"],
  sum_assured: ["sum assured", "sa", "coverage", "benefit amount", "face amount"],
  premium_amount: ["premium", "premium amount", "modal premium", "gross premium", "annual premium"],
  premium_mode: ["mode", "premium mode", "payment mode", "frequency", "billing frequency"],
  inception_date: [
    "inception date", "inception", "commencement date", "issue date",
    "start date", "policy date", "effective date", "risk commencement date",
  ],
  maturity_date: ["maturity date", "maturity", "expiry date", "end date"],
  next_premium_due: ["next due", "next premium due", "due date", "next payment date", "paid to date"],
};

function normaliseHeader(header: string): string {
  return header.toLowerCase().trim().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The alias lists are written the way a human would type them ("d.o.b",
 * "policy no."), so they have to go through the same normalisation as the
 * incoming header before being compared. Comparing a normalised header against
 * a raw alias silently fails to match, which means a real column gets ignored.
 */
const NORMALISED_ALIASES: Record<string, string[]> = Object.fromEntries(
  Object.entries(COLUMN_ALIASES).map(([field, aliases]) => [
    field,
    aliases.map(normaliseHeader),
  ]),
);

/** Work out which spreadsheet column means what. */
export function mapColumns(headers: string[]): { mapping: Record<string, string>; unmapped: string[] } {
  const mapping: Record<string, string> = {};
  const unmapped: string[] = [];

  for (const header of headers) {
    const key = normaliseHeader(header);
    let matched = false;

    for (const [field, aliases] of Object.entries(NORMALISED_ALIASES)) {
      if (aliases.includes(key)) {
        // First column wins, so a sheet with both "Name" and "Client Name"
        // does not silently flip between them.
        if (!Object.values(mapping).includes(field)) {
          mapping[header] = field;
        }
        matched = true;
        break;
      }
    }
    if (!matched) unmapped.push(header);
  }

  return { mapping, unmapped };
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/** Dates arrive as dd/mm/yyyy, yyyy-mm-dd, Excel serials, and more besides. */
export function parseDate(value: unknown): string | null {
  if (value == null || value === "") return null;

  // Excel stores dates as days since 1899-12-30.
  if (typeof value === "number" && value > 20000 && value < 60000) {
    const ms = (value - 25569) * 86400 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  const text = String(value).trim();

  // Already ISO.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);

  // dd/mm/yyyy or dd-mm-yyyy. Singapore convention is day first, which matters:
  // reading 03/04/2024 as March would put a birthday a month out.
  const dmy = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? `20${y}` : y;
    const day = d.padStart(2, "0");
    const month = m.padStart(2, "0");
    if (Number(month) > 12) return null;   // clearly not day-first; refuse to guess
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function parseMoney(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

export function parseMode(value: unknown): string | null {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  if (/month|mth|\bm\b/.test(v)) return "monthly";
  if (/quarter|qtr|\bq\b/.test(v)) return "quarterly";
  if (/semi|half|\bs\b/.test(v)) return "semi_annual";
  if (/ann|year|yr|\ba\b/.test(v)) return "annual";
  if (/single|lump/.test(v)) return "single";
  return null;
}

export function parseStatus(value: unknown): string {
  if (!value) return "in_force";
  const v = String(value).toLowerCase().trim();
  if (/lapse/.test(v)) return "lapsed";
  if (/paid.?up/.test(v)) return "paid_up";
  if (/matur/.test(v)) return "matured";
  if (/surrend/.test(v)) return "surrendered";
  if (/cancel|terminat/.test(v)) return "cancelled";
  if (/pending|underwrit|uw/.test(v)) return "pending_uw";
  if (/claim/.test(v)) return "claim_paid";
  return "in_force";
}

export function parsePolicyType(value: unknown): string | null {
  if (!value) return null;
  const v = String(value).toLowerCase();
  if (/term/.test(v)) return "term_life";
  if (/whole/.test(v)) return "whole_life";
  if (/endow|savings/.test(v)) return "endowment";
  if (/ilp|invest.?link|unit.?link/.test(v)) return "ilp";
  if (/critical|ci\b|dread/.test(v)) return "ci_standalone";
  if (/shield|hospital|medical|health|shield/.test(v)) return "hospital";
  if (/annuit|retire/.test(v)) return "annuity";
  if (/accident|pa\b/.test(v)) return "accident";
  if (/disab|income/.test(v)) return "disability";
  if (/rider/.test(v)) return "rider";
  return "other";
}

// ---------------------------------------------------------------------------
// Spreadsheet import
// ---------------------------------------------------------------------------

interface StagedRow {
  full_name: string;
  client_fields: Record<string, unknown>;
  policy_fields: Record<string, unknown>;
  has_policy: boolean;
}

function parseSheet(bytes: Uint8Array): {
  rows: StagedRow[];
  mapping: Record<string, string>;
  unmapped: string[];
  headers: string[];
} {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("That file has no sheets in it.");

  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  if (raw.length === 0) throw new Error("That sheet is empty.");

  const headers = Object.keys(raw[0]);
  const { mapping, unmapped } = mapColumns(headers);

  if (!Object.values(mapping).includes("full_name")) {
    throw new Error(
      "I can't find a name column. I looked for: " +
      COLUMN_ALIASES.full_name.join(", "),
    );
  }

  const rows: StagedRow[] = [];

  for (const record of raw) {
    const mapped: Record<string, unknown> = {};
    for (const [header, field] of Object.entries(mapping)) {
      mapped[field] = record[header];
    }

    const name = String(mapped.full_name ?? "").trim();
    if (!name) continue;   // a row with no name is not a client

    const client_fields: Record<string, unknown> = {
      full_name: scrubNric(name),
      dob: parseDate(mapped.dob),
      phone: mapped.phone ? String(mapped.phone).trim() : null,
      email: mapped.email ? String(mapped.email).trim() : null,
      occupation: mapped.occupation ? scrubNric(String(mapped.occupation)) : null,
      gender: mapped.gender
        ? (String(mapped.gender).toUpperCase().startsWith("M") ? "M"
          : String(mapped.gender).toUpperCase().startsWith("F") ? "F" : null)
        : null,
    };

    const policyNumber = mapped.policy_number ? String(mapped.policy_number).trim() : null;
    const planName = mapped.plan_name ? String(mapped.plan_name).trim() : null;
    const has_policy = Boolean(policyNumber || planName);

    const policy_fields: Record<string, unknown> = has_policy
      ? {
        insurer: mapped.insurer ? String(mapped.insurer).trim() : "Unknown",
        plan_name: planName ?? "Unnamed plan",
        policy_number: policyNumber,
        policy_type: parsePolicyType(mapped.policy_type ?? planName),
        status: parseStatus(mapped.status),
        sum_assured: parseMoney(mapped.sum_assured),
        premium_amount: parseMoney(mapped.premium_amount),
        premium_mode: parseMode(mapped.premium_mode),
        inception_date: parseDate(mapped.inception_date),
        maturity_date: parseDate(mapped.maturity_date),
        next_premium_due: parseDate(mapped.next_premium_due),
      }
      : {};

    rows.push({ full_name: client_fields.full_name as string, client_fields, policy_fields, has_policy });
  }

  return { rows, mapping, unmapped, headers };
}

async function stageSpreadsheet(
  chatId: number,
  doc: TelegramDocument,
  bytes: Uint8Array,
): Promise<void> {
  const { rows, mapping, unmapped } = parseSheet(bytes);

  if (rows.length === 0) {
    await sendMessage(chatId, "I read the file but found no rows with a name in them.");
    return;
  }

  const withPolicy = rows.filter((r) => r.has_policy).length;
  const uniqueNames = new Set(rows.map((r) => r.full_name.toLowerCase()));

  const { data, error } = await db()
    .from("import_batches")
    .insert({
      chat_id: chatId,
      source_filename: doc.file_name ?? "upload",
      kind: withPolicy > 0 ? "mixed" : "clients",
      row_count: rows.length,
      parsed_rows: rows,
      column_mapping: mapping,
      summary: `${rows.length} rows, ${uniqueNames.size} distinct names, ${withPolicy} with policy details`,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Could not stage the import: ${error.message}`);

  const recognised = Object.entries(mapping)
    .map(([header, field]) => `  ${esc(header)} → ${field}`)
    .join("\n");

  const ignored = unmapped.length > 0
    ? `\n\n<b>Columns I ignored</b>\n${unmapped.map((u) => `  ${esc(u)}`).join("\n")}`
    : "";

  await sendMessage(
    chatId,
    `📄 <b>${esc(doc.file_name ?? "Import")}</b>\n\n` +
    `${rows.length} rows · ${uniqueNames.size} distinct people · ${withPolicy} with policy details\n\n` +
    `<b>Columns I recognised</b>\n${recognised}${ignored}\n\n` +
    `Nothing has been saved yet. Reply <code>/apply ${data.id.slice(0, 8)}</code> to ` +
    `bring this in, or just ignore it and it stays staged.\n\n` +
    `<i>Existing clients are matched by name and updated rather than duplicated. ` +
    `Policies are matched by insurer and policy number.</i>`,
  );
}

/**
 * Apply a staged import. Matches on name for clients and on insurer + policy
 * number for policies, so re-importing next month updates rather than duplicates.
 */
export async function applyImport(chatId: number, batchPrefix: string): Promise<void> {
  const { data: batches, error } = await db()
    .from("import_batches")
    .select("*")
    .eq("chat_id", chatId)
    .eq("status", "staged")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(error.message);

  const batch = (batches ?? []).find((b) => String(b.id).startsWith(batchPrefix));
  if (!batch) {
    await sendMessage(chatId, `I can't find a staged import starting <code>${esc(batchPrefix)}</code>.`);
    return;
  }

  const rows = batch.parsed_rows as StagedRow[];
  let clientsCreated = 0, clientsUpdated = 0, policiesCreated = 0, policiesUpdated = 0;
  const problems: string[] = [];

  for (const row of rows) {
    try {
      // --- client ---
      const { data: existing } = await db()
        .from("clients")
        .select("id")
        .ilike("full_name", row.full_name)
        .limit(1)
        .maybeSingle();

      const fields = Object.fromEntries(
        Object.entries(row.client_fields).filter(([, v]) => v != null && v !== ""),
      );

      let clientId: string;
      if (existing) {
        clientId = existing.id;
        // Only fill blanks on update. A portal export should not overwrite a
        // phone number you corrected by hand last week.
        const { data: current } = await db()
          .from("clients").select("*").eq("id", clientId).single();

        const toFill = Object.fromEntries(
          Object.entries(fields).filter(([k]) => current?.[k] == null),
        );
        if (Object.keys(toFill).length > 0) {
          await db().from("clients").update(toFill).eq("id", clientId);
        }
        clientsUpdated += 1;
      } else {
        const { data: created, error: createError } = await db()
          .from("clients").insert(fields).select("id").single();
        if (createError) throw new Error(createError.message);
        clientId = created.id;
        clientsCreated += 1;
      }

      // --- policy ---
      if (row.has_policy) {
        const pf: Record<string, unknown> = { ...row.policy_fields, client_id: clientId };
        const policyNumber = pf.policy_number as string | null;

        if (policyNumber) {
          const { data: existingPolicy } = await db()
            .from("policies")
            .select("id")
            .eq("insurer", String(pf.insurer))
            .eq("policy_number", policyNumber)
            .maybeSingle();

          if (existingPolicy) {
            const updates = Object.fromEntries(
              Object.entries(pf).filter(([, v]) => v != null && v !== ""),
            );
            await db().from("policies").update(updates).eq("id", existingPolicy.id);
            policiesUpdated += 1;
            continue;
          }
        }

        const { error: policyError } = await db().from("policies").insert(pf);
        if (policyError) throw new Error(policyError.message);
        policiesCreated += 1;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      problems.push(`${row.full_name}: ${msg}`);
    }
  }

  await db()
    .from("import_batches")
    .update({ status: problems.length === rows.length ? "failed" : "applied", applied_at: new Date().toISOString() })
    .eq("id", batch.id);

  const problemBlock = problems.length > 0
    ? `\n\n<b>${problems.length} row(s) had trouble</b>\n` +
      problems.slice(0, 8).map((p) => `  • ${esc(p)}`).join("\n") +
      (problems.length > 8 ? `\n  …and ${problems.length - 8} more` : "")
    : "";

  await sendMessage(
    chatId,
    `✅ <b>Import applied</b>\n\n` +
    `Clients: ${clientsCreated} new, ${clientsUpdated} matched\n` +
    `Policies: ${policiesCreated} new, ${policiesUpdated} updated` +
    problemBlock,
  );
}

// ---------------------------------------------------------------------------
// Product documents
// ---------------------------------------------------------------------------

/**
 * Split on blank lines, then pack into chunks of roughly 1,200 characters with
 * a little overlap. Paragraph boundaries keep a benefit table or an exclusion
 * clause intact rather than cut in half, which matters a great deal when the
 * product desk is quoting the result back to you.
 */
export function chunkText(text: string, target = 1200, overlap = 150): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > target && current.length > 0) {
      chunks.push(current);
      current = current.slice(-overlap) + "\n\n" + para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current);

  return chunks.filter((c) => c.trim().length > 50);   // drop page-furniture fragments
}

async function ingestProductDocument(
  chatId: number,
  doc: TelegramDocument,
  bytes: Uint8Array,
  caption?: string,
): Promise<void> {
  const filename = doc.file_name ?? "document.pdf";

  // The caption is how you tell me what this is: "AIA Max VitalHealth A"
  const label = (caption ?? filename.replace(/\.[^.]+$/, "")).trim();
  const insurerGuess = label.split(/\s+/)[0] ?? "Unknown";

  let text = "";
  let pageCount: number | null = null;

  if (filename.toLowerCase().endsWith(".pdf") || doc.mime_type === "application/pdf") {
    const pdf = await getDocumentProxy(bytes);
    pageCount = pdf.numPages;
    const result = await extractText(pdf, { mergePages: true });
    text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
  } else {
    text = new TextDecoder().decode(bytes);
  }

  text = scrubNric(text.replace(/\r/g, ""));

  if (text.trim().length < 200) {
    await sendMessage(
      chatId,
      `I could not read useful text out of <b>${esc(filename)}</b>.\n\n` +
      `<i>If it is a scanned document, the pages are images rather than text — ` +
      `that needs OCR, which is not set up here. A text-based PDF from the ` +
      `insurer's website will work.</i>`,
    );
    return;
  }

  // Keep the original, so a better parser later can re-read it.
  const storagePath = `${Date.now()}-${filename}`;
  const { error: uploadError } = await db().storage
    .from("products")
    .upload(storagePath, bytes, {
      contentType: doc.mime_type ?? "application/pdf",
      upsert: false,
    });
  if (uploadError) console.error("storage upload failed:", uploadError.message);

  const { data: product, error: productError } = await db()
    .from("products")
    .insert({
      insurer: insurerGuess,
      name: label,
      doc_type: /contract|policy.?doc|terms/i.test(filename)
        ? "policy_contract"
        : /brochure/i.test(filename)
        ? "brochure"
        : "product_summary",
      storage_path: uploadError ? null : storagePath,
      source_filename: filename,
      page_count: pageCount,
      ingested_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (productError) throw new Error(`Could not record the document: ${productError.message}`);

  const chunks = chunkText(text);
  const records = chunks.map((content, i) => ({
    product_id: product.id,
    chunk_index: i,
    content,
  }));

  // Insert in batches; a long contract can run to hundreds of chunks.
  for (let i = 0; i < records.length; i += 100) {
    const { error } = await db().from("product_chunks").insert(records.slice(i, i + 100));
    if (error) throw new Error(`Could not index the document: ${error.message}`);
  }

  await sendMessage(
    chatId,
    `📚 <b>Added to the library</b>\n\n` +
    `${esc(label)}\n` +
    `${pageCount ? `${pageCount} pages · ` : ""}${chunks.length} searchable sections\n\n` +
    `I filed it under insurer <b>${esc(insurerGuess)}</b>. If that's wrong, tell me ` +
    `and I'll correct it.\n\n` +
    `<i>Ask me about it any time — I'll quote the document rather than answer ` +
    `from memory.</i>`,
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleDocument(
  chatId: number,
  doc: TelegramDocument,
  caption?: string,
): Promise<void> {
  const filename = (doc.file_name ?? "").toLowerCase();

  try {
    const bytes = await downloadFile(doc.file_id);

    if (/\.(csv|xlsx|xls)$/.test(filename)) {
      await stageSpreadsheet(chatId, doc, bytes);
      return;
    }

    if (/\.(pdf|txt|md)$/.test(filename)) {
      await ingestProductDocument(chatId, doc, bytes, caption);
      return;
    }

    await sendMessage(
      chatId,
      `I don't know what to do with <b>${esc(doc.file_name ?? "that")}</b>.\n\n` +
      `Send me a <code>.csv</code> or <code>.xlsx</code> export to update client ` +
      `records, or a <code>.pdf</code> product document for the library.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("document ingest failed:", msg);
    await sendMessage(chatId, `That file gave me trouble.\n\n<code>${esc(msg)}</code>`);
  }
}
