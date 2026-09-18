-- ============================================================================
-- 0013_retire_riders_array.sql
-- Finishes the move begun in 0011.
--
-- 0011 made riders real rows, each with their own coverage type, sum assured
-- and expiry. The old policies.riders text[] survived alongside them, which is
-- worse than either option on its own: two places to record the same thing,
-- and no way to tell which one is authoritative.
--
-- This drops it, and brings client_dossier() up to date so a dossier reports
-- the new fields instead of the retired array.
--
-- Anything currently in riders is copied into extra first, so nothing is lost
-- even on a database that has been in use.
-- ============================================================================

update policies
   set extra = extra || jsonb_build_object('legacy_riders', to_jsonb(riders))
 where riders is not null
   and array_length(riders, 1) > 0;

alter table policies drop column if exists riders;

-- Redefined to match: no riders array, and carrying the fields 0011 added.
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
