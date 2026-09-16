-- ============================================================================
-- 0003_products_and_ops.sql
-- The product desk's library, plus the plumbing the office needs to run:
-- conversation memory, spend tracking, import staging and settings.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- products -- one row per document you upload
-- ---------------------------------------------------------------------------

create table products (
  id             uuid primary key default gen_random_uuid(),
  insurer        text not null,
  name           text not null,
  product_type   text,                 -- mirrors policies.policy_type vocabulary
  doc_type       text check (doc_type in
                   ('product_summary','brochure','policy_contract','benefit_illustration',
                    'fund_factsheet','underwriting_guide','rate_table','circular','other'))
                 default 'product_summary',

  storage_path   text,                 -- path inside the Supabase 'products' bucket
  source_filename text,
  effective_date date,
  status         text check (status in ('current','superseded','withdrawn')) default 'current',

  page_count     integer,
  ingested_at    timestamptz,
  ingest_error   text,

  created_at     timestamptz not null default now()
);

create index products_insurer_idx on products (insurer);
create index products_status_idx  on products (status);

-- ---------------------------------------------------------------------------
-- product_chunks -- searchable slices of each document
--
-- Full-text search rather than vector embeddings, for two reasons: it is free
-- (no embedding API call per chunk), and insurance language is precise enough
-- that keyword search genuinely works -- "deferment period", "CI multiplier",
-- "pre-existing exclusion" are exact terms, not fuzzy concepts.
-- ---------------------------------------------------------------------------

create table product_chunks (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete cascade,
  chunk_index  integer not null,
  page_from    integer,
  page_to      integer,
  heading      text,
  content      text not null,

  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
    setweight(to_tsvector('english', content), 'B')
  ) stored,

  created_at   timestamptz not null default now(),
  unique (product_id, chunk_index)
);

create index product_chunks_fts_idx     on product_chunks using gin (search_vector);
create index product_chunks_product_idx on product_chunks (product_id);

-- Search across the library, returning enough context for the product desk to
-- quote accurately and cite which document the answer came from.
create or replace function search_products(
  query_text   text,
  insurer_filter text default null,
  max_results  integer default 8
)
returns table (
  chunk_id     uuid,
  product_id   uuid,
  insurer      text,
  product_name text,
  doc_type     text,
  heading      text,
  content      text,
  page_from    integer,
  rank         real
)
language sql stable as $$
  select
    pc.id,
    p.id,
    p.insurer,
    p.name,
    p.doc_type,
    pc.heading,
    pc.content,
    pc.page_from,
    ts_rank(pc.search_vector, websearch_to_tsquery('english', query_text)) as rank
  from product_chunks pc
  join products p on p.id = pc.product_id
  where pc.search_vector @@ websearch_to_tsquery('english', query_text)
    and p.status = 'current'
    and (insurer_filter is null or p.insurer ilike insurer_filter)
  order by rank desc
  limit greatest(1, least(max_results, 25));
$$;

-- ---------------------------------------------------------------------------
-- conversations -- so the manager remembers what you said two messages ago
-- ---------------------------------------------------------------------------

create table conversation_turns (
  id          bigserial primary key,
  chat_id     bigint not null,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);

create index conversation_turns_chat_idx on conversation_turns (chat_id, created_at desc);

-- ---------------------------------------------------------------------------
-- ai_usage -- every model call, so the spend cap is enforceable and auditable
-- ---------------------------------------------------------------------------

create table ai_usage (
  id             bigserial primary key,
  occurred_at    timestamptz not null default now(),
  usage_date     date not null default (now() at time zone 'Asia/Singapore')::date,
  agent          text not null,        -- 'manager', 'staff:policy', ...
  model          text not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  cache_read_tokens integer not null default 0,
  est_cost_usd   numeric(10,6) not null default 0
);

create index ai_usage_date_idx on ai_usage (usage_date);

create or replace function ai_spend_today() returns numeric
language sql stable as $$
  select coalesce(sum(est_cost_usd), 0)
    from ai_usage
   where usage_date = (now() at time zone 'Asia/Singapore')::date;
$$;

-- ---------------------------------------------------------------------------
-- import_batches -- staging for spreadsheet imports, so nothing lands in your
-- client list until you have looked at it and said yes.
-- ---------------------------------------------------------------------------

create table import_batches (
  id            uuid primary key default gen_random_uuid(),
  chat_id       bigint,
  source_filename text,
  kind          text check (kind in ('clients','policies','mixed')) default 'mixed',
  status        text check (status in ('staged','applied','discarded','failed')) default 'staged',

  row_count     integer not null default 0,
  parsed_rows   jsonb not null default '[]'::jsonb,
  column_mapping jsonb,
  summary       text,
  error         text,

  created_at    timestamptz not null default now(),
  applied_at    timestamptz
);

create index import_batches_chat_idx on import_batches (chat_id, created_at desc);

-- ---------------------------------------------------------------------------
-- app_settings -- one row, editable from the Supabase dashboard
-- ---------------------------------------------------------------------------

create table app_settings (
  id                    integer primary key default 1 check (id = 1),
  daily_spend_cap_usd   numeric(8,2) not null default 1.00,
  briefing_enabled      boolean not null default true,
  briefing_hour_sgt     integer not null default 7 check (briefing_hour_sgt between 0 and 23),
  monthly_export_reminder boolean not null default true,
  quiet_on_weekends     boolean not null default false,
  updated_at            timestamptz not null default now()
);

insert into app_settings (id) values (1) on conflict do nothing;

create trigger app_settings_touch before update on app_settings
  for each row execute function touch_updated_at();
