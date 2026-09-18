-- ============================================================================
-- 0011_real_export_shape.sql
-- Reshaped after seeing a real AIA Portfolio Summary.
--
-- Four things the original schema got wrong, all of which would have bitten
-- on the first real import:
--
-- 1. UNIQUE (insurer, policy_number) was actively harmful. Real exports mask
--    the number down to its last four digits (******1556). A main plan and its
--    rider share that number, so a single client's own policies collide with
--    each other -- and across a few hundred clients, four digits collide by
--    birthday paradox almost immediately. The constraint would have rejected
--    legitimate rows and silently merged unrelated ones.
--
-- 2. Riders are not a text[]. They are policies in their own right, each with
--    its own coverage type, sum assured, term and expiry, hanging off a parent.
--
-- 3. A policy can be paid TWO ways at once -- part cash, part CPF. One
--    premium_amount plus a paid_from_cpf boolean cannot express that.
--
-- 4. Sum assured is not always a number. For hospitalisation it is a ward
--    class ("Restructured (A ward)").
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. The unique constraint
-- --------------------------------------------------------------------------

alter table policies drop constraint if exists policies_insurer_policy_number_key;

-- The policy number SHOULD be unique -- once it is a real number. The problem
-- is only the masked form the export gives ('******1556'), which is shared
-- between a plan and its rider and collides across clients.
--
-- So: keep both. policy_number holds the real number you type in, and is
-- enforced unique. policy_number_masked holds whatever the export gave, for
-- matching on re-import until the real one is filled in.

alter table policies
  add column if not exists policy_number_masked text;

-- Recognises the masked form: any run of asterisks followed by digits.
create or replace function is_masked_policy_number(value text) returns boolean
language sql immutable as $$
  select value is not null and value ~ '^[*x\u2022]+\s*[0-9]+$';
$$;

-- Unique, but only over real numbers. A masked or absent number is skipped,
-- so an import never fails and never silently merges two people's policies.
create unique index if not exists policies_real_number_idx
  on policies (insurer, policy_number)
  where policy_number is not null and not is_masked_policy_number(policy_number);

comment on index policies_real_number_idx is
  'Policy numbers are unique per insurer once they are real. Masked export values are excluded, because four digits are shared between a plan and its rider and collide across clients.';

-- What re-import matches on until a real number exists: one plan, one client,
-- one start date.
create unique index if not exists policies_identity_idx
  on policies (client_id, insurer, plan_name, coalesce(inception_date, '1900-01-01'));

-- Move a masked value out of policy_number into its own column automatically,
-- so the field you type into is always the real one.
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

-- --------------------------------------------------------------------------
-- 2. Riders as first-class rows
-- --------------------------------------------------------------------------

alter table policies
  add column if not exists parent_policy_id uuid references policies(id) on delete cascade,
  add column if not exists is_rider boolean not null default false,
  add column if not exists coverage_type text;

create index if not exists policies_parent_idx on policies (parent_policy_id);

comment on column policies.coverage_type is
  'What this line actually covers, in the insurer''s own words: Hospitalisation, Death, Multi-stage CI, Major CI, TPD, Acc. Death / TPD, Acc. Reimbursement, Disability Income, Others.';
comment on column policies.parent_policy_id is
  'Set on riders. The main plan they attach to.';

-- --------------------------------------------------------------------------
-- 3. Two premium streams
-- --------------------------------------------------------------------------

alter table policies
  add column if not exists premium_cash          numeric(12,2),
  add column if not exists premium_non_cash      numeric(12,2),
  add column if not exists non_cash_source       text,   -- 'CPF MediSave', 'CPF OA', ...
  add column if not exists payment_method        text,   -- 'Cash', 'Credit Card', 'GIRO'
  add column if not exists premium_frequency     text;   -- as printed: 'annually', 'monthly'

comment on column policies.premium_non_cash is
  'The CPF-funded portion. A policy can be part cash and part CPF at the same time, which the original single premium_amount could not represent.';

-- --------------------------------------------------------------------------
-- 4. Sum assured that is not a number, and the values an export carries
-- --------------------------------------------------------------------------

alter table policies
  add column if not exists coverage_descriptor       text,  -- 'Restructured (A ward)'
  -- The ceiling on what the plan will pay, distinct from a sum assured.
  -- Hospitalisation plans express cover as a ward class plus an annual limit.
  add column if not exists annual_claim_limit        numeric(14,2),
  add column if not exists lifetime_claim_limit      numeric(14,2),
  add column if not exists payment_term_years        integer,
  add column if not exists payment_until_age         integer,
  add column if not exists coverage_expiry_date      date,
  add column if not exists total_premium_paid        numeric(14,2),
  add column if not exists surrender_value           numeric(14,2),
  add column if not exists surrender_value_asof      date,
  add column if not exists net_asset_value           numeric(14,2),
  add column if not exists net_asset_value_asof      date,
  add column if not exists projected_maturity_value  numeric(14,2);

comment on column policies.coverage_descriptor is
  'Cover expressed as a class rather than a sum -- hospitalisation ward type, for instance. Sits alongside sum_assured, which stays null in that case.';

-- --------------------------------------------------------------------------
-- Provenance. Which document did this row come from, and when?
-- Without it there is no way to tell a hand-typed correction from something an
-- import will overwrite next month.
-- --------------------------------------------------------------------------

alter table policies
  add column if not exists source_document text,
  add column if not exists source_asof     date;

alter table clients
  add column if not exists source_document text,
  add column if not exists source_asof     date,
  -- The insurer's own premium rollup, worth keeping because it is what the
  -- client sees on their own statement.
  --
  -- Note: annual_income is deliberately NOT imported from a portfolio summary.
  -- The insurer holds a declared figure that may be years stale, and the
  -- protection-gap maths below multiplies it by nine. A wrong income silently
  -- produces a wrong recommendation, so that field stays yours to set.
  add column if not exists total_annual_premium numeric(12,2);

-- --------------------------------------------------------------------------
-- Backfill the new premium columns from the old single one, so nothing that
-- was already entered by hand is stranded.
-- --------------------------------------------------------------------------

update policies
   set premium_cash     = case when not paid_from_cpf then premium_amount end,
       premium_non_cash = case when paid_from_cpf then premium_amount end,
       non_cash_source  = case when paid_from_cpf then cpf_account end
 where premium_amount is not null
   and premium_cash is null
   and premium_non_cash is null;

-- --------------------------------------------------------------------------
-- Keep premium_amount meaningful: it is now the TOTAL of both streams, so
-- every existing query, view and briefing keeps working unchanged.
-- --------------------------------------------------------------------------

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
