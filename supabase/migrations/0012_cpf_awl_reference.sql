-- ============================================================================
-- 0012_cpf_awl_reference.sql
-- What MediSave will and will not pay for, as reference data.
--
-- Why a table rather than numbers in code: MOH revises these limits. A figure
-- hardcoded in an agent prompt goes stale invisibly and ends up quoted to a
-- client. Here it carries an effective date and a source, and updating it is
-- one INSERT.
--
-- Figures below are the Additional Withdrawal Limits as published by CPF and
-- MOH. VERIFY BEFORE QUOTING TO A CLIENT -- see source_note.
-- ============================================================================

create table if not exists cpf_awl_limits (
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

comment on table cpf_awl_limits is
  'MediSave Additional Withdrawal Limits by age band. Applies ON TOP of the MediShield Life component, which is fully MediSave-payable. Premiums above the limit must be paid in cash.';

-- --------------------------------------------------------------------------
-- The rule that catches people out: an Integrated Shield RIDER -- the add-on
-- covering deductible and co-insurance -- can NEVER be paid from MediSave.
-- Always cash, at any age, whatever the AWL.
--
-- This function is what the policy desk should consult rather than reasoning
-- about it, because reasoning about it is exactly where a plausible-sounding
-- wrong answer comes from.
-- --------------------------------------------------------------------------

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

comment on function medisave_payable is
  'Whether a given policy line can be paid from MediSave, and up to what annual limit. Encodes the rider exception explicitly so no agent has to infer it.';
