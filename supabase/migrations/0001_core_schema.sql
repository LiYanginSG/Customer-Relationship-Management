-- ============================================================================
-- 0001_core_schema.sql
-- The filing cabinet: clients, their families, their policies, and every
-- conversation you have had with them.
--
-- Design note: every table here is readable and editable by hand in the
-- Supabase Table Editor. That is deliberate -- you should never be locked out
-- of your own client data by a bot that is having a bad day.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- Enumerated types. Kept as text + check constraints rather than PG enums so
-- that adding a new insurer or policy type later is a one-line migration
-- instead of a type rewrite.
-- ---------------------------------------------------------------------------

create domain premium_mode as text
  check (value in ('monthly','quarterly','semi_annual','annual','single','limited_pay'));

create domain policy_status as text
  check (value in ('in_force','lapsed','paid_up','matured','surrendered','claim_paid','pending_uw','cancelled'));

create domain client_status as text
  check (value in ('prospect','active','dormant','lapsed','referral_only','former'));

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

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
  annual_income       numeric(12,2),

  email               text,
  phone               text,
  address_area        text,          -- "Punggol", "Bukit Timah" -- enough to plan a day of visits
  smoker              boolean,

  risk_profile        text check (risk_profile in ('conservative','moderate','balanced','growth','aggressive')),
  client_since        date,
  status              client_status not null default 'active',

  referred_by         uuid references clients(id) on delete set null,
  source              text,          -- "roadshow", "referral", "warm market", "orphan case"

  -- Free-form standing context the relationship desk maintains: hobbies,
  -- children's names, "hates phone calls, text only", dietary restrictions.
  profile_notes       text,

  -- Servicing cadence. Used by the sales desk to decide who has gone cold.
  review_interval_days integer not null default 180,
  last_contacted_at   timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index clients_dob_idx           on clients (dob);
create index clients_status_idx        on clients (status);
create index clients_last_contacted_idx on clients (last_contacted_at);
create index clients_name_trgm_idx     on clients using gin (full_name gin_trgm_ops);

comment on column clients.review_interval_days is
  'How often this client expects to hear from you. The sales desk flags anyone past this.';

-- ---------------------------------------------------------------------------
-- family_members
-- Children's birthdays matter as much as the client''s, and a new baby is the
-- single most reliable trigger for a coverage conversation.
-- ---------------------------------------------------------------------------

create table family_members (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  name          text,
  relationship  text not null check (relationship in
                  ('spouse','child','parent','sibling','domestic_partner','other')),
  dob           date,
  is_dependent  boolean not null default false,
  is_insured    boolean not null default false,   -- covered under one of your policies?
  notes         text,
  created_at    timestamptz not null default now()
);

create index family_members_client_idx on family_members (client_id);
create index family_members_dob_idx    on family_members (dob);

-- ---------------------------------------------------------------------------
-- policies
-- ---------------------------------------------------------------------------

create table policies (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,

  insurer           text not null,
  plan_name         text not null,
  policy_number     text,
  policy_type       text check (policy_type in
                      ('term_life','whole_life','endowment','ilp','ci_standalone',
                       'hospital','rider','annuity','accident','disability',
                       'travel','motor','home','business','other')),

  status            policy_status not null default 'in_force',

  sum_assured       numeric(14,2),
  premium_amount    numeric(12,2),
  premium_mode      premium_mode,
  premium_due_day   integer check (premium_due_day between 1 and 31),
  next_premium_due  date,
  premium_term_years integer,
  policy_term_years  integer,

  inception_date    date,
  maturity_date     date,

  -- Singapore specifics
  paid_from_cpf     boolean not null default false,   -- CPF OA/SA or MediSave funded
  cpf_account       text check (cpf_account in ('oa','sa','medisave','ma_shield','none')),
  is_integrated_shield boolean not null default false,

  riders            text[],
  beneficiaries     text,

  -- Servicing
  last_reviewed_at  date,
  notes             text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (insurer, policy_number)
);

create index policies_client_idx     on policies (client_id);
create index policies_status_idx     on policies (status);
create index policies_due_idx        on policies (next_premium_due);
create index policies_inception_idx  on policies (inception_date);

comment on column policies.next_premium_due is
  'Concrete next due date. Kept as a stored column so the free noticeboard can query it without any date arithmetic in the app layer.';

-- ---------------------------------------------------------------------------
-- interactions -- the relationship desk''s memory
-- ---------------------------------------------------------------------------

create table interactions (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  occurred_at   timestamptz not null default now(),
  channel       text check (channel in
                  ('meeting','call','whatsapp','email','telegram','event','note','other'))
                default 'meeting',

  summary       text not null,        -- one or two lines, the bit you will re-read
  detail        text,                 -- the full dictated note
  topics        text[],               -- ['retirement','cpf_sa_topup','newborn']
  sentiment     text check (sentiment in ('positive','neutral','concerned','negative')),

  -- Set when the note was filed by the AI rather than typed by you, so you can
  -- always tell machine-written recollection from your own words.
  ai_generated  boolean not null default false,

  created_at    timestamptz not null default now()
);

create index interactions_client_idx  on interactions (client_id, occurred_at desc);
create index interactions_topics_idx  on interactions using gin (topics);

-- Keep clients.last_contacted_at in step automatically. The sales desk depends
-- on this being accurate, and relying on the app to remember would be fragile.
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

-- ---------------------------------------------------------------------------
-- action_items -- things you promised to do
-- ---------------------------------------------------------------------------

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

create index action_items_open_idx on action_items (status, due_date) where status = 'open';
create index action_items_client_idx on action_items (client_id);

-- ---------------------------------------------------------------------------
-- opportunities -- the sales desk''s working list
-- ---------------------------------------------------------------------------

create table opportunities (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,

  kind          text check (kind in
                  ('protection_gap','retirement_gap','review_due','upsell',
                   'cross_sell','referral','claim_support','lapse_risk')),
  headline      text not null,
  rationale     text,                 -- why the system thinks this is live
  est_annual_premium numeric(12,2),

  status        text check (status in ('open','working','won','lost','parked')) default 'open',
  next_step     text,
  next_step_date date,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index opportunities_open_idx on opportunities (status, next_step_date);
create index opportunities_client_idx on opportunities (client_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

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
