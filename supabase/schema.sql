-- ============================================================================
-- schema.sql -- the whole database, in one file.
--
-- FOR A FRESH SUPABASE PROJECT. Paste this into the SQL Editor and run it once.
--
-- The numbered files in migrations/ are the history of how this was built,
-- including a few things that were got wrong and corrected later. You do not
-- need that history on a new database, and running twelve files in the right
-- order is twelve chances to make a mistake. This is the same end state in one
-- paste.
--
-- If you have ALREADY run some of the numbered migrations, do not use this
-- file -- carry on with the numbered ones instead.
--
-- Verified: this produces a schema identical to running every migration in
-- order, checked by diffing pg_dump output of both.
--
-- What this does NOT include: the scheduled jobs. Those need your project
-- reference and your own secret, so they stay in migrations/0008_schedule.sql.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ============================================================================
-- TYPES
-- Text plus a check constraint rather than a Postgres enum, so adding a new
-- insurer or policy status later is a one-line change instead of a type rewrite.
-- ============================================================================

create domain premium_mode as text
  check (value in ('monthly','quarterly','semi_annual','annual','single','limited_pay'));

create domain policy_status as text
  check (value in ('in_force','lapsed','paid_up','matured','surrendered','claim_paid','pending_uw','cancelled'));

create domain client_status as text
  check (value in ('prospect','active','dormant','lapsed','referral_only','former'));

-- ============================================================================
-- PEOPLE
-- ============================================================================

create table clients (
  id                  uuid primary key default gen_random_uuid(),
  full_name           text not null,
  preferred_name      text,
  dob                 date,
  gender              text check (gender in ('M','F','other')),
  marital_status      text check (marital_status in ('single','married','divorced','widowed')),

  -- Residency drives CPF eligibility, which drives half of Singapore planning.
  residency           text check (residency in ('citizen','pr','ep_spass','foreigner','unknown'))
                      default 'unknown',

  occupation          text,
  employer            text,

  -- Deliberately NOT imported from an insurer's portfolio summary. Their
  -- declared figure can be years stale, and the protection-gap maths
  -- multiplies it by nine -- a wrong income quietly yields a wrong
  -- recommendation. This field stays yours to set.
  annual_income       numeric(12,2),

  email               text,
  phone               text,
  address_area        text,          -- "Punggol" -- enough to plan a day of visits
  smoker              boolean,

  risk_profile        text check (risk_profile in ('conservative','moderate','balanced','growth','aggressive')),
  client_since        date,
  status              client_status not null default 'active',

  referred_by         uuid references clients(id) on delete set null,
  source              text,

  -- Standing context: hobbies, children's names, "text only, never call".
  profile_notes       text,

  -- How often this client expects to hear from you. The sales desk flags
  -- anyone past their own cadence rather than one blanket rule.
  review_interval_days integer not null default 180,
  last_contacted_at   timestamptz,

  -- Columns an import brought in that have no field of their own yet. Kept
  -- rather than discarded, because the schema is a considered guess at your
  -- principal's export and silently dropping a column is the worst way to be
  -- wrong about that.
  extra               jsonb not null default '{}'::jsonb,

  source_document     text,
  source_asof         date,
  total_annual_premium numeric(12,2),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index clients_dob_idx            on clients (dob);
create index clients_status_idx         on clients (status);
create index clients_last_contacted_idx on clients (last_contacted_at);
create index clients_name_trgm_idx      on clients using gin (full_name gin_trgm_ops);
create index clients_extra_idx          on clients using gin (extra);

-- Children's birthdays matter as much as the client's, and a new baby is the
-- most reliable trigger for a cover conversation there is.
create table family_members (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  name          text,
  relationship  text not null check (relationship in
                  ('spouse','child','parent','sibling','domestic_partner','other')),
  dob           date,
  is_dependent  boolean not null default false,
  is_insured    boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now()
);

create index family_members_client_idx on family_members (client_id);
create index family_members_dob_idx    on family_members (dob);

-- ============================================================================
-- POLICIES
--
-- Shaped around a real insurer's portfolio summary rather than a guess:
--
--   - Riders are rows, not a list of names. Each has its own coverage type,
--     sum assured, term and expiry. A TPD rider ending at age 70 under a
--     parent running to 100 is a planning fact worth keeping.
--   - A plan can be paid part cash and part CPF at the same time.
--   - Cover is not always a number. Hospitalisation is a ward class plus an
--     annual claim limit.
--   - Policy numbers arrive masked to four digits, shared between a plan and
--     its rider, so they cannot be the identity key until you type the real one.
-- ============================================================================

create table policies (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,

  insurer           text not null,
  plan_name         text not null,

  -- The real number, which you type in. Unique per insurer once present.
  policy_number     text,
  -- Whatever the export gave, e.g. ******1556. Moved here automatically.
  policy_number_masked text,

  policy_type       text check (policy_type in
                      ('term_life','whole_life','endowment','ilp','ci_standalone',
                       'hospital','rider','annuity','accident','disability',
                       'travel','motor','home','business','other')),

  -- What this line actually covers, in the insurer's own words.
  coverage_type     text,
  -- Cover expressed as a class rather than a sum: "Restructured (A ward)".
  coverage_descriptor text,

  status            policy_status not null default 'in_force',

  -- Riders hang off a parent plan.
  parent_policy_id  uuid references policies(id) on delete cascade,
  is_rider          boolean not null default false,

  sum_assured       numeric(14,2),
  annual_claim_limit   numeric(14,2),
  lifetime_claim_limit numeric(14,2),

  -- Two premium streams. premium_amount and paid_from_cpf below are DERIVED
  -- from these by trigger, so every view and query that predates the split
  -- keeps working unchanged.
  premium_cash      numeric(12,2),
  premium_non_cash  numeric(12,2),
  non_cash_source   text,     -- 'CPF MediSave', 'CPF OA', 'SRS'
  payment_method    text,     -- 'Cash', 'Credit Card', 'GIRO'
  premium_frequency text,     -- as printed: 'annually'

  premium_amount    numeric(12,2),
  premium_mode      premium_mode,
  premium_due_day   integer check (premium_due_day between 1 and 31),
  next_premium_due  date,
  premium_term_years integer,
  policy_term_years  integer,
  payment_term_years integer,
  payment_until_age  integer,

  inception_date       date,
  maturity_date        date,
  coverage_expiry_date date,

  paid_from_cpf     boolean not null default false,
  cpf_account       text check (cpf_account in ('oa','sa','medisave','ma_shield','none')),
  is_integrated_shield boolean not null default false,

  total_premium_paid       numeric(14,2),
  surrender_value          numeric(14,2),
  surrender_value_asof     date,
  net_asset_value          numeric(14,2),
  net_asset_value_asof     date,
  projected_maturity_value numeric(14,2),

  beneficiaries     text,
  last_reviewed_at  date,
  notes             text,

  extra             jsonb not null default '{}'::jsonb,
  source_document   text,
  source_asof       date,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index policies_client_idx    on policies (client_id);
create index policies_status_idx    on policies (status);
create index policies_due_idx       on policies (next_premium_due);
create index policies_inception_idx on policies (inception_date);
create index policies_parent_idx    on policies (parent_policy_id);
create index policies_extra_idx     on policies using gin (extra);

-- Recognises a masked policy number: asterisks or bullets, then digits.
create or replace function is_masked_policy_number(value text) returns boolean
language sql immutable as $$
  select value is not null and value ~ '^[*x•]+\s*[0-9]+$';
$$;

-- Unique, but only over REAL numbers. A masked or absent number is skipped, so
-- an import never fails and never silently merges two people's policies.
create unique index policies_real_number_idx
  on policies (insurer, policy_number)
  where policy_number is not null and not is_masked_policy_number(policy_number);

-- What a re-import matches on until a real number exists.
create unique index policies_identity_idx
  on policies (client_id, insurer, plan_name, coalesce(inception_date, '1900-01-01'));

-- ============================================================================
-- CONVERSATIONS, PROMISES, OPPORTUNITIES
-- ============================================================================

create table interactions (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  occurred_at   timestamptz not null default now(),
  channel       text check (channel in
                  ('meeting','call','whatsapp','email','telegram','event','note','other'))
                default 'meeting',

  summary       text not null,   -- the bit you re-read before the next meeting
  detail        text,
  topics        text[],
  sentiment     text check (sentiment in ('positive','neutral','concerned','negative')),

  -- True when the manager wrote this from something you dictated, rather than
  -- you typing it. So machine recollection is always distinguishable from
  -- your own words.
  ai_generated  boolean not null default false,

  created_at    timestamptz not null default now()
);

create index interactions_client_idx on interactions (client_id, occurred_at desc);
create index interactions_topics_idx on interactions using gin (topics);

create table action_items (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  interaction_id  uuid references interactions(id) on delete set null,

  title           text not null,
  detail          text,
  due_date        date,
  priority        text check (priority in ('low','normal','high','urgent')) default 'normal',
  status          text check (status in ('open','done','dropped','snoozed')) default 'open',

  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index action_items_open_idx   on action_items (status, due_date) where status = 'open';
create index action_items_client_idx on action_items (client_id);

create table opportunities (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,

  kind          text check (kind in
                  ('protection_gap','retirement_gap','review_due','upsell',
                   'cross_sell','referral','claim_support','lapse_risk')),
  headline      text not null,
  rationale     text,
  est_annual_premium numeric(12,2),

  status        text check (status in ('open','working','won','lost','parked')) default 'open',
  next_step     text,
  next_step_date date,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index opportunities_open_idx   on opportunities (status, next_step_date);
create index opportunities_client_idx on opportunities (client_id);

-- ============================================================================
-- PRODUCT LIBRARY
-- ============================================================================

create table products (
  id             uuid primary key default gen_random_uuid(),
  insurer        text not null,
  name           text not null,
  product_type   text,
  doc_type       text check (doc_type in
                   ('product_summary','brochure','policy_contract','benefit_illustration',
                    'fund_factsheet','underwriting_guide','rate_table','circular','other'))
                 default 'product_summary',

  storage_path   text,
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

-- Full-text search rather than vector embeddings: it is free, and insurance
-- wording is precise enough that keyword search genuinely works. "Deferment
-- period" and "pre-existing exclusion" are exact terms, not fuzzy concepts.
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

-- ============================================================================
-- OPERATIONS
-- ============================================================================

create table conversation_turns (
  id          bigserial primary key,
  chat_id     bigint not null,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);

create index conversation_turns_chat_idx on conversation_turns (chat_id, created_at desc);

create table ai_usage (
  id             bigserial primary key,
  occurred_at    timestamptz not null default now(),
  usage_date     date not null default (now() at time zone 'Asia/Singapore')::date,
  agent          text not null,
  model          text not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  cache_read_tokens integer not null default 0,
  est_cost_usd   numeric(10,6) not null default 0
);

create index ai_usage_date_idx on ai_usage (usage_date);

-- Staging, so nothing from a spreadsheet lands in your client list until you
-- have looked at it and said yes.
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

-- ============================================================================
-- CPF REFERENCE
--
-- A table rather than numbers in code, because MOH revises these. A figure
-- hardcoded in an agent's prompt goes stale invisibly and ends up quoted to a
-- client. Here it carries an effective date and a source.
-- ============================================================================

create table cpf_awl_limits (
  id              serial primary key,
  age_band_from   integer not null,
  age_band_to     integer,              -- null means "and above"
  annual_limit    numeric(10,2) not null,
  effective_from  date not null,
  source_note     text,
  created_at      timestamptz not null default now(),
  unique (age_band_from, effective_from)
);

insert into cpf_awl_limits (age_band_from, age_band_to, annual_limit, effective_from, source_note)
values
  (0,  40,   300.00, '2021-01-01',
   'Age next birthday 40 and below. CPF/MOH Additional Withdrawal Limit for the private component of an Integrated Shield Plan. Confirm against cpf.gov.sg before quoting.'),
  (41, 70,   600.00, '2021-01-01',
   'Age next birthday 41 to 70. Confirm against cpf.gov.sg before quoting.'),
  (71, null, 900.00, '2021-01-01',
   'Age next birthday 71 and above. Confirm against cpf.gov.sg before quoting.')
on conflict do nothing;

-- ============================================================================
-- NRIC GUARD
--
-- The brief was explicit: everything else is fine, but no NRIC. Enforced here
-- rather than trusted to the application. An NRIC or FIN cannot be stored even
-- if pasted by accident, even if an import file is full of them, and even if
-- the AI tries to write one back.
--
-- Format: one of S T F G M, seven digits, one check letter.
-- ============================================================================

create or replace function scrub_nric(input text) returns text
language plpgsql immutable as $$
begin
  if input is null then
    return null;
  end if;
  -- \m and \M are word boundaries, so an ordinary word containing a similar
  -- run of characters is left alone.
  return regexp_replace(input, '\m[STFGMstfgm][0-9]{7}[A-Za-z]\M', '[NRIC-REMOVED]', 'g');
end;
$$;

-- An unmapped column is exactly where a stray identifier would hide, since
-- nobody is looking at it. So the guard reaches into the jsonb too.
create or replace function scrub_jsonb_nric(input jsonb) returns jsonb
language sql immutable as $$
  select coalesce(
    (select jsonb_object_agg(key, case
        when jsonb_typeof(value) = 'string'
          then to_jsonb(scrub_nric(value #>> '{}'))
        else value
      end)
     from jsonb_each(input)),
    '{}'::jsonb
  );
$$;

create or replace function scrub_client_nric() returns trigger
language plpgsql as $$
begin
  new.full_name      := scrub_nric(new.full_name);
  new.preferred_name := scrub_nric(new.preferred_name);
  new.profile_notes  := scrub_nric(new.profile_notes);
  new.occupation     := scrub_nric(new.occupation);
  new.employer       := scrub_nric(new.employer);
  new.source         := scrub_nric(new.source);
  new.address_area   := scrub_nric(new.address_area);
  new.extra          := scrub_jsonb_nric(new.extra);
  return new;
end;
$$;

create or replace function scrub_policy_nric() returns trigger
language plpgsql as $$
begin
  -- policy_number included deliberately: some insurers historically used the
  -- NRIC as the policy identifier, and those must not survive an import.
  new.policy_number  := scrub_nric(new.policy_number);
  new.notes          := scrub_nric(new.notes);
  new.beneficiaries  := scrub_nric(new.beneficiaries);
  new.plan_name      := scrub_nric(new.plan_name);
  new.extra          := scrub_jsonb_nric(new.extra);
  return new;
end;
$$;

create or replace function scrub_interaction_nric() returns trigger
language plpgsql as $$
begin
  new.summary := scrub_nric(new.summary);
  new.detail  := scrub_nric(new.detail);
  return new;
end;
$$;

create or replace function scrub_family_nric() returns trigger
language plpgsql as $$
begin
  new.name  := scrub_nric(new.name);
  new.notes := scrub_nric(new.notes);
  return new;
end;
$$;

create or replace function scrub_action_item_nric() returns trigger
language plpgsql as $$
begin
  new.title  := scrub_nric(new.title);
  new.detail := scrub_nric(new.detail);
  return new;
end;
$$;

create or replace function scrub_opportunity_nric() returns trigger
language plpgsql as $$
begin
  new.headline  := scrub_nric(new.headline);
  new.rationale := scrub_nric(new.rationale);
  new.next_step := scrub_nric(new.next_step);
  return new;
end;
$$;

create trigger clients_scrub_nric       before insert or update on clients       for each row execute function scrub_client_nric();
create trigger policies_scrub_nric      before insert or update on policies      for each row execute function scrub_policy_nric();
create trigger interactions_scrub_nric  before insert or update on interactions  for each row execute function scrub_interaction_nric();
create trigger family_scrub_nric        before insert or update on family_members for each row execute function scrub_family_nric();
create trigger action_items_scrub_nric  before insert or update on action_items  for each row execute function scrub_action_item_nric();
create trigger opportunities_scrub_nric before insert or update on opportunities for each row execute function scrub_opportunity_nric();

-- ============================================================================
-- MAINTENANCE TRIGGERS
-- ============================================================================

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger clients_touch       before update on clients       for each row execute function touch_updated_at();
create trigger policies_touch      before update on policies      for each row execute function touch_updated_at();
create trigger opportunities_touch before update on opportunities for each row execute function touch_updated_at();
create trigger app_settings_touch  before update on app_settings  for each row execute function touch_updated_at();

-- Keep clients.last_contacted_at accurate automatically. The sales desk
-- depends on it, and relying on the application to remember would be fragile.
create or replace function sync_last_contacted() returns trigger
language plpgsql as $$
begin
  update clients
     set last_contacted_at = greatest(coalesce(last_contacted_at, new.occurred_at), new.occurred_at),
         updated_at        = now()
   where id = new.client_id;
  return new;
end;
$$;

create trigger interactions_sync_last_contacted
  after insert on interactions
  for each row execute function sync_last_contacted();

-- premium_amount stays the TOTAL of both streams, and paid_from_cpf follows,
-- so every view, briefing and query written before the split keeps working.
create or replace function sync_premium_total() returns trigger
language plpgsql as $$
begin
  if new.premium_cash is not null or new.premium_non_cash is not null then
    new.premium_amount := coalesce(new.premium_cash, 0) + coalesce(new.premium_non_cash, 0);
    new.paid_from_cpf  := coalesce(new.premium_non_cash, 0) > 0;
  end if;
  return new;
end;
$$;

create trigger policies_sync_premium_total
  before insert or update on policies
  for each row execute function sync_premium_total();

-- Move a masked value out of policy_number into its own column, so the field
-- you type into is always the real one.
create or replace function split_masked_policy_number() returns trigger
language plpgsql as $$
begin
  if is_masked_policy_number(new.policy_number) then
    new.policy_number_masked := coalesce(new.policy_number_masked, new.policy_number);
    new.policy_number := null;
  end if;
  return new;
end;
$$;

create trigger policies_split_masked_number
  before insert or update on policies
  for each row execute function split_masked_policy_number();

-- ============================================================================
-- DATE HELPERS
-- ============================================================================

-- Given a past date, when does it next come round? Handles the year wrap (a
-- December birthday seen from January) and clamps 29 February to the 28th in
-- non-leap years.
create or replace function next_anniversary(d date, from_date date)
returns date
language plpgsql immutable as $$
declare
  y int; m int; dd int; last_day int; cand date;
begin
  if d is null or from_date is null then
    return null;
  end if;

  y  := extract(year  from from_date)::int;
  m  := extract(month from d)::int;
  dd := extract(day   from d)::int;

  last_day := extract(day from (make_date(y, m, 1) + interval '1 month' - interval '1 day'))::int;
  cand     := make_date(y, m, least(dd, last_day));

  if cand < from_date then
    y        := y + 1;
    last_day := extract(day from (make_date(y, m, 1) + interval '1 month' - interval '1 day'))::int;
    cand     := make_date(y, m, least(dd, last_day));
  end if;

  return cand;
end;
$$;

-- Today in Singapore, regardless of where the server sits. Getting this wrong
-- by eight hours means a birthday alert arriving the day after the birthday.
create or replace function sg_today() returns date
language sql stable as $$
  select (now() at time zone 'Asia/Singapore')::date;
$$;

-- ============================================================================
-- THE FREE HALF
--
-- Everything below is plain SQL. No AI, no API key, no per-use cost. These
-- answer the questions the morning briefing asks, and they are also what your
-- own Claude subscription reads if you connect it to this database directly.
-- ============================================================================

create or replace view v_upcoming_birthdays as
select
  c.id                              as client_id,
  c.full_name                       as client_name,
  coalesce(c.preferred_name, c.full_name) as display_name,
  'client'                          as whose,
  null::text                        as relationship,
  c.dob,
  next_anniversary(c.dob, sg_today())                       as next_birthday,
  next_anniversary(c.dob, sg_today()) - sg_today()          as days_away,
  extract(year from age(next_anniversary(c.dob, sg_today()), c.dob))::int as turning,
  c.phone,
  c.status::text                    as client_status,
  c.last_contacted_at
from clients c
where c.dob is not null
  and c.status in ('active','prospect','dormant')

union all

select
  c.id,
  c.full_name,
  coalesce(f.name, initcap(f.relationship)),
  'family',
  f.relationship,
  f.dob,
  next_anniversary(f.dob, sg_today()),
  next_anniversary(f.dob, sg_today()) - sg_today(),
  extract(year from age(next_anniversary(f.dob, sg_today()), f.dob))::int,
  c.phone,
  c.status::text,
  c.last_contacted_at
from family_members f
join clients c on c.id = f.client_id
where f.dob is not null
  and c.status in ('active','prospect','dormant');

create or replace view v_policy_anniversaries as
select
  p.id                       as policy_id,
  p.client_id,
  c.full_name                as client_name,
  coalesce(c.preferred_name, c.full_name) as display_name,
  p.insurer,
  p.plan_name,
  p.policy_number,
  p.policy_type,
  p.sum_assured,
  p.premium_amount,
  p.premium_mode::text,
  p.inception_date,
  next_anniversary(p.inception_date, sg_today())              as next_anniversary,
  next_anniversary(p.inception_date, sg_today()) - sg_today() as days_away,
  extract(year from age(next_anniversary(p.inception_date, sg_today()), p.inception_date))::int as years_in_force,
  p.last_reviewed_at,
  c.phone
from policies p
join clients c on c.id = p.client_id
where p.inception_date is not null
  and p.status = 'in_force';

create or replace view v_premiums_due as
select
  p.id           as policy_id,
  p.client_id,
  c.full_name    as client_name,
  coalesce(c.preferred_name, c.full_name) as display_name,
  p.insurer,
  p.plan_name,
  p.policy_number,
  p.premium_amount,
  p.premium_mode::text,
  p.next_premium_due,
  p.next_premium_due - sg_today() as days_away,
  p.paid_from_cpf,
  p.cpf_account,
  c.phone
from policies p
join clients c on c.id = p.client_id
where p.status = 'in_force'
  and p.next_premium_due is not null;

create or replace view v_clients_gone_quiet as
select
  c.id                       as client_id,
  c.full_name                as client_name,
  coalesce(c.preferred_name, c.full_name) as display_name,
  c.status::text             as client_status,
  c.last_contacted_at,
  c.review_interval_days,
  case
    when c.last_contacted_at is null then null
    else (sg_today() - (c.last_contacted_at at time zone 'Asia/Singapore')::date)
  end                        as days_since_contact,
  case
    when c.last_contacted_at is null then 9999
    else (sg_today() - (c.last_contacted_at at time zone 'Asia/Singapore')::date) - c.review_interval_days
  end                        as days_overdue,
  (select count(*) from policies p
    where p.client_id = c.id and p.status = 'in_force') as policies_in_force,
  (select sum(p.premium_amount) from policies p
    where p.client_id = c.id and p.status = 'in_force') as total_premium,
  c.phone
from clients c
where c.status in ('active','dormant')
  and (
    c.last_contacted_at is null
    or (sg_today() - (c.last_contacted_at at time zone 'Asia/Singapore')::date) > c.review_interval_days
  );

create or replace view v_open_actions as
select
  a.id           as action_id,
  a.client_id,
  c.full_name    as client_name,
  coalesce(c.preferred_name, c.full_name) as display_name,
  a.title,
  a.detail,
  a.due_date,
  a.due_date - sg_today() as days_away,
  a.priority,
  a.created_at
from action_items a
left join clients c on c.id = a.client_id
where a.status = 'open';

create or replace view v_reviews_overdue as
select
  p.id        as policy_id,
  p.client_id,
  c.full_name as client_name,
  p.insurer,
  p.plan_name,
  p.policy_type,
  p.sum_assured,
  p.last_reviewed_at,
  case
    when p.last_reviewed_at is null then sg_today() - p.inception_date
    else sg_today() - p.last_reviewed_at
  end as days_since_review
from policies p
join clients c on c.id = p.client_id
where p.status = 'in_force'
  and (
    p.last_reviewed_at is null
    or p.last_reviewed_at < sg_today() - interval '365 days'
  );

-- ============================================================================
-- FUNCTIONS THE APPLICATION CALLS
-- ============================================================================

-- The whole morning briefing in one JSON object. Pure SQL -- costs nothing.
create or replace function build_daily_briefing(
  birthday_horizon_days     integer default 7,
  premium_horizon_days      integer default 10,
  anniversary_horizon_days  integer default 14,
  quiet_limit               integer default 5
)
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'generated_for', sg_today(),

    'birthdays', coalesce((
      select jsonb_agg(t order by t.days_away, t.client_name)
      from (
        select client_id, client_name, display_name, whose, relationship,
               next_birthday, days_away, turning, phone, client_status,
               last_contacted_at
        from v_upcoming_birthdays
        where days_away between 0 and birthday_horizon_days
      ) t
    ), '[]'::jsonb),

    'premiums_due', coalesce((
      select jsonb_agg(t order by t.days_away, t.client_name)
      from (
        select client_id, client_name, display_name, insurer, plan_name,
               policy_number, premium_amount, premium_mode, next_premium_due,
               days_away, paid_from_cpf, phone
        from v_premiums_due
        where days_away <= premium_horizon_days
      ) t
    ), '[]'::jsonb),

    'anniversaries', coalesce((
      select jsonb_agg(t order by t.days_away, t.client_name)
      from (
        select client_id, client_name, display_name, insurer, plan_name,
               policy_type, sum_assured, next_anniversary, days_away,
               years_in_force, last_reviewed_at
        from v_policy_anniversaries
        where days_away between 0 and anniversary_horizon_days
      ) t
    ), '[]'::jsonb),

    'gone_quiet', coalesce((
      select jsonb_agg(t order by t.days_overdue desc)
      from (
        select client_id, client_name, display_name, days_since_contact,
               days_overdue, policies_in_force, total_premium, phone
        from v_clients_gone_quiet
        order by days_overdue desc
        limit quiet_limit
      ) t
    ), '[]'::jsonb),

    'actions_due', coalesce((
      select jsonb_agg(t order by t.due_date nulls last)
      from (
        select action_id, client_id, client_name, display_name, title,
               detail, due_date, days_away, priority
        from v_open_actions
        where due_date is not null and days_away <= 3
      ) t
    ), '[]'::jsonb),

    'counts', jsonb_build_object(
      'clients',          (select count(*) from clients where status in ('active','prospect')),
      'policies_in_force',(select count(*) from policies where status = 'in_force'),
      'open_actions',     (select count(*) from action_items where status = 'open'),
      'overdue_actions',  (select count(*) from v_open_actions where days_away < 0)
    )
  );
$$;

-- Everything known about one person, in a single call.
create or replace function client_dossier(target uuid)
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'client', (
      select to_jsonb(c) - 'created_at' - 'updated_at'
      from clients c where c.id = target
    ),
    'family', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', f.name, 'relationship', f.relationship, 'dob', f.dob,
        'is_dependent', f.is_dependent, 'is_insured', f.is_insured, 'notes', f.notes))
      from family_members f where f.client_id = target
    ), '[]'::jsonb),
    'policies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'insurer', p.insurer, 'plan_name', p.plan_name, 'policy_number', p.policy_number,
        'policy_number_masked', p.policy_number_masked,
        'policy_type', p.policy_type, 'coverage_type', p.coverage_type,
        'coverage_descriptor', p.coverage_descriptor, 'status', p.status,
        'sum_assured', p.sum_assured, 'annual_claim_limit', p.annual_claim_limit,
        'premium_amount', p.premium_amount, 'premium_cash', p.premium_cash,
        'premium_non_cash', p.premium_non_cash, 'non_cash_source', p.non_cash_source,
        'premium_mode', p.premium_mode, 'is_rider', p.is_rider,
        'inception_date', p.inception_date, 'coverage_expiry_date', p.coverage_expiry_date,
        'next_premium_due', p.next_premium_due, 'paid_from_cpf', p.paid_from_cpf,
        'last_reviewed_at', p.last_reviewed_at, 'notes', p.notes)
        order by p.is_rider, p.inception_date desc)
      from policies p where p.client_id = target
    ), '[]'::jsonb),
    'recent_interactions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'occurred_at', i.occurred_at, 'channel', i.channel, 'summary', i.summary,
        'detail', i.detail, 'topics', i.topics, 'sentiment', i.sentiment)
        order by i.occurred_at desc)
      from (
        select * from interactions
        where client_id = target
        order by occurred_at desc
        limit 10
      ) i
    ), '[]'::jsonb),
    'open_actions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', a.title, 'detail', a.detail, 'due_date', a.due_date, 'priority', a.priority))
      from action_items a where a.client_id = target and a.status = 'open'
    ), '[]'::jsonb),
    'opportunities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', o.kind, 'headline', o.headline, 'rationale', o.rationale,
        'status', o.status, 'next_step', o.next_step, 'next_step_date', o.next_step_date))
      from opportunities o where o.client_id = target and o.status in ('open','working')
    ), '[]'::jsonb)
  );
$$;

-- Product search. Tries an all-terms match first, then falls back to any-term.
--
-- The fallback matters: Postgres stems "excluded" to "exclud" and "exclusion"
-- to "exclus", so a search for "pre-existing exclusion" would otherwise miss a
-- clause saying "pre-existing conditions are excluded" -- exactly the passage
-- wanted. match_type tells the caller which pass produced the result, so a
-- loose match can be reported as loose rather than quoted as definitive.
create or replace function search_products(
  query_text     text,
  insurer_filter text default null,
  max_results    integer default 8
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
  rank         real,
  match_type   text
)
language plpgsql stable as $$
declare
  strict_query tsquery;
  loose_query  tsquery;
  hits         integer;
  lexemes      text[];
  limit_to     integer := greatest(1, least(coalesce(max_results, 8), 25));
begin
  if query_text is null or btrim(query_text) = '' then
    return;
  end if;

  strict_query := websearch_to_tsquery('english', query_text);

  select count(*) into hits
    from product_chunks pc
    join products p on p.id = pc.product_id
   where pc.search_vector @@ strict_query
     and p.status = 'current'
     and (insurer_filter is null or p.insurer ilike insurer_filter);

  if hits > 0 then
    return query
      select pc.id, p.id, p.insurer, p.name, p.doc_type, pc.heading, pc.content,
             pc.page_from,
             ts_rank(pc.search_vector, strict_query) as rank,
             'exact'::text
        from product_chunks pc
        join products p on p.id = pc.product_id
       where pc.search_vector @@ strict_query
         and p.status = 'current'
         and (insurer_filter is null or p.insurer ilike insurer_filter)
       order by rank desc
       limit limit_to;
    return;
  end if;

  lexemes := tsvector_to_array(to_tsvector('english', query_text));

  -- A query of nothing but stop words leaves no lexemes, and to_tsquery('')
  -- raises. Returning empty is the honest answer.
  if lexemes is null or array_length(lexemes, 1) is null then
    return;
  end if;

  loose_query := to_tsquery('english', array_to_string(lexemes, ' | '));

  return query
    select pc.id, p.id, p.insurer, p.name, p.doc_type, pc.heading, pc.content,
           pc.page_from,
           ts_rank(pc.search_vector, loose_query) as rank,
           'partial'::text
      from product_chunks pc
      join products p on p.id = pc.product_id
     where pc.search_vector @@ loose_query
       and p.status = 'current'
       and (insurer_filter is null or p.insurer ilike insurer_filter)
     order by rank desc
     limit limit_to;
end;
$$;

create or replace function ai_spend_today() returns numeric
language sql stable as $$
  select coalesce(sum(est_cost_usd), 0)
    from ai_usage
   where usage_date = (now() at time zone 'Asia/Singapore')::date;
$$;

-- Whether a policy line can be paid from MediSave, and up to what limit.
--
-- Encodes the rule most often got wrong: an Integrated Shield RIDER can never
-- be paid from MediSave, at any age, whatever the withdrawal limit. Stated
-- explicitly so no agent has to infer it.
create or replace function medisave_payable(
  policy_coverage_type text,
  policy_is_rider      boolean,
  age_next_birthday    integer
)
returns jsonb
language sql stable as $$
  select case
    when policy_is_rider then
      jsonb_build_object(
        'medisave_payable', false,
        'annual_limit', 0,
        'reason', 'Integrated Shield riders must be paid in cash. MediSave cannot be used for rider premiums at any age.')
    when policy_coverage_type is distinct from 'Hospitalisation' then
      jsonb_build_object(
        'medisave_payable', false,
        'annual_limit', 0,
        'reason', 'MediSave covers Integrated Shield Plan premiums only. Life, CI, PA and other lines are cash or other funds.')
    else
      jsonb_build_object(
        'medisave_payable', true,
        'annual_limit', (
          select annual_limit from cpf_awl_limits
           where age_next_birthday >= age_band_from
             and (age_band_to is null or age_next_birthday <= age_band_to)
           order by effective_from desc
           limit 1),
        'reason', 'The MediShield Life component is fully MediSave-payable. The private component is payable up to the Additional Withdrawal Limit for this age band; anything above it is cash.')
  end;
$$;

-- ============================================================================
-- SECURITY
--
-- Supabase ships a public "anon" key that is embedded in browsers and is not a
-- secret. Row Level Security is what stops that key reading your client list.
-- Every table below has RLS ON and NO policy, which means the anon and
-- authenticated keys can read nothing and write nothing.
--
-- The edge functions and the portal use the service_role key, which bypasses
-- RLS by design. That key must never leave the server.
-- ============================================================================

alter table clients            enable row level security;
alter table family_members     enable row level security;
alter table policies           enable row level security;
alter table interactions       enable row level security;
alter table action_items       enable row level security;
alter table opportunities      enable row level security;
alter table products           enable row level security;
alter table product_chunks     enable row level security;
alter table conversation_turns enable row level security;
alter table ai_usage           enable row level security;
alter table import_batches     enable row level security;
alter table app_settings       enable row level security;
alter table cpf_awl_limits     enable row level security;

-- Deliberately no policies. Deny-by-default is the whole point.

-- A view normally runs with its creator's privileges, which would let it leak
-- past RLS. security_invoker makes it respect the caller's permissions.
alter view v_upcoming_birthdays   set (security_invoker = on);
alter view v_policy_anniversaries set (security_invoker = on);
alter view v_premiums_due         set (security_invoker = on);
alter view v_clients_gone_quiet   set (security_invoker = on);
alter view v_open_actions         set (security_invoker = on);
alter view v_reviews_overdue      set (security_invoker = on);

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ============================================================================
-- STORAGE
-- Private buckets: no public URL, no forwardable link.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'products', 'products', false, 52428800,
  array['application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain','text/markdown']
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imports', 'imports', false, 20971520,
  array['text/csv','application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/octet-stream']
)
on conflict (id) do nothing;

-- ============================================================================
-- Done. Next: migrations/0008_schedule.sql for the 7am briefing, once you have
-- your project reference and cron secret.
-- ============================================================================
