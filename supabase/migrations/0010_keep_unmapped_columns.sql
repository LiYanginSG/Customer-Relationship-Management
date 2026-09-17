-- ============================================================================
-- 0010_keep_unmapped_columns.sql
-- Never throw away a column just because it was not expected.
--
-- The schema is a considered guess at what a Singapore adviser's portal export
-- contains. It will be wrong in places -- every principal names things
-- differently and carries fields nobody else does.
--
-- Previously, a column the importer did not recognise was dropped. That is the
-- worst possible behaviour: the adviser imports, everything looks fine, and
-- six weeks later discovers the surrender value column never made it.
--
-- Now anything unrecognised is kept verbatim in `extra`. Nothing is lost, the
-- portal shows it, and when a field earns a proper column later it can be
-- backfilled from here rather than re-imported.
-- ============================================================================

alter table clients  add column if not exists extra jsonb not null default '{}'::jsonb;
alter table policies add column if not exists extra jsonb not null default '{}'::jsonb;

comment on column clients.extra is
  'Columns from an import that had no matching field. Kept so nothing is lost before the schema catches up.';
comment on column policies.extra is
  'Columns from an import that had no matching field. Kept so nothing is lost before the schema catches up.';

-- Searchable, so "which clients have an agent code recorded" is answerable
-- without a full scan once these get used.
create index if not exists clients_extra_idx  on clients  using gin (extra);
create index if not exists policies_extra_idx on policies using gin (extra);

-- The NRIC guard has to reach in here too. An unmapped column is exactly where
-- a stray identifier would hide, since nobody is looking at it.
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
  new.policy_number  := scrub_nric(new.policy_number);
  new.notes          := scrub_nric(new.notes);
  new.beneficiaries  := scrub_nric(new.beneficiaries);
  new.plan_name      := scrub_nric(new.plan_name);
  new.extra          := scrub_jsonb_nric(new.extra);
  return new;
end;
$$;
