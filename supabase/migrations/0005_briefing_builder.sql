-- ============================================================================
-- 0005_briefing_builder.sql
-- Assembles the 7am briefing in one database call, with no AI involved.
-- Returns JSON so the Telegram function can format it without doing any
-- thinking of its own.
-- ============================================================================

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

comment on function build_daily_briefing is
  'The whole morning briefing in one JSON object. Pure SQL -- costs nothing to run.';

-- ---------------------------------------------------------------------------
-- A compact client dossier, for when you (or the manager) want everything
-- known about one person in a single call.
-- ---------------------------------------------------------------------------

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
        'policy_type', p.policy_type, 'status', p.status, 'sum_assured', p.sum_assured,
        'premium_amount', p.premium_amount, 'premium_mode', p.premium_mode,
        'inception_date', p.inception_date, 'next_premium_due', p.next_premium_due,
        'paid_from_cpf', p.paid_from_cpf, 'riders', p.riders,
        'last_reviewed_at', p.last_reviewed_at, 'notes', p.notes)
        order by p.inception_date desc)
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
