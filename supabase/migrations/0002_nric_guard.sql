-- ============================================================================
-- 0002_nric_guard.sql
-- You said: everything is fine, just no NRIC.
--
-- This enforces that at the database level rather than trusting the
-- application to behave. An NRIC or FIN cannot be stored here even if you
-- paste one in by accident, even if an import file contains a column of them,
-- and even if the AI tries to write one back. It is scrubbed on the way in.
--
-- Singapore NRIC/FIN format: one of S T F G M, seven digits, one check letter.
-- ============================================================================

create or replace function scrub_nric(input text) returns text
language plpgsql immutable as $$
begin
  if input is null then
    return null;
  end if;
  -- \m and \M are word boundaries, so this will not mangle an ordinary word
  -- that happens to contain a similar run of characters.
  return regexp_replace(input, '\m[STFGMstfgm][0-9]{7}[A-Za-z]\M', '[NRIC-REMOVED]', 'g');
end;
$$;

comment on function scrub_nric(text) is
  'Removes Singapore NRIC/FIN numbers from free text. Applied by trigger to every free-text column that accepts user or AI input.';

-- --------------------------------------------------------------------------
-- Per-table scrubbing triggers.
-- --------------------------------------------------------------------------

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
  return new;
end;
$$;

create trigger clients_scrub_nric
  before insert or update on clients
  for each row execute function scrub_client_nric();

create or replace function scrub_policy_nric() returns trigger
language plpgsql as $$
begin
  -- policy_number is deliberately included. Some insurers historically used
  -- the NRIC as the policy identifier; those must not survive import.
  new.policy_number  := scrub_nric(new.policy_number);
  new.notes          := scrub_nric(new.notes);
  new.beneficiaries  := scrub_nric(new.beneficiaries);
  new.plan_name      := scrub_nric(new.plan_name);
  return new;
end;
$$;

create trigger policies_scrub_nric
  before insert or update on policies
  for each row execute function scrub_policy_nric();

create or replace function scrub_interaction_nric() returns trigger
language plpgsql as $$
begin
  new.summary := scrub_nric(new.summary);
  new.detail  := scrub_nric(new.detail);
  return new;
end;
$$;

create trigger interactions_scrub_nric
  before insert or update on interactions
  for each row execute function scrub_interaction_nric();

create or replace function scrub_family_nric() returns trigger
language plpgsql as $$
begin
  new.name  := scrub_nric(new.name);
  new.notes := scrub_nric(new.notes);
  return new;
end;
$$;

create trigger family_scrub_nric
  before insert or update on family_members
  for each row execute function scrub_family_nric();

create or replace function scrub_action_item_nric() returns trigger
language plpgsql as $$
begin
  new.title  := scrub_nric(new.title);
  new.detail := scrub_nric(new.detail);
  return new;
end;
$$;

create trigger action_items_scrub_nric
  before insert or update on action_items
  for each row execute function scrub_action_item_nric();

create or replace function scrub_opportunity_nric() returns trigger
language plpgsql as $$
begin
  new.headline  := scrub_nric(new.headline);
  new.rationale := scrub_nric(new.rationale);
  new.next_step := scrub_nric(new.next_step);
  return new;
end;
$$;

create trigger opportunities_scrub_nric
  before insert or update on opportunities
  for each row execute function scrub_opportunity_nric();
