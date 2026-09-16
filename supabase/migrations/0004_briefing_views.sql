-- ============================================================================
-- 0004_briefing_views.sql
-- The free half of the system.
--
-- Everything in this file is plain SQL. No AI, no API key, no per-use cost.
-- These views answer the questions you asked for -- whose birthday is coming,
-- which premiums are due, which policies hit an anniversary, who has gone
-- quiet -- using nothing but date arithmetic.
--
-- They are also what your own Claude subscription reads when you connect it to
-- this database and ask a question directly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- next_anniversary: given a past date, when does it next come round?
-- Handles the year wrap (a December birthday seen from January) and clamps
-- 29 February to the 28th in non-leap years.
-- ---------------------------------------------------------------------------

create or replace function next_anniversary(d date, from_date date)
returns date
language plpgsql immutable as $$
declare
  y    int;
  m    int;
  dd   int;
  last_day int;
  cand date;
begin
  if d is null or from_date is null then
    return null;
  end if;

  y  := extract(year  from from_date)::int;
  m  := extract(month from d)::int;
  dd := extract(day   from d)::int;

  -- Clamp to the last valid day of that month in the target year.
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

-- Today, in Singapore, regardless of where the server happens to sit.
create or replace function sg_today() returns date
language sql stable as $$
  select (now() at time zone 'Asia/Singapore')::date;
$$;

-- ---------------------------------------------------------------------------
-- Birthdays -- clients and their family members in one list.
-- Children's birthdays are included because they are often the better
-- conversation opener, and because a child turning 21 is a real planning event.
-- ---------------------------------------------------------------------------

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

comment on view v_upcoming_birthdays is
  'Every upcoming birthday, client and family, with how many days away and what age they turn. Filter on days_away.';

-- ---------------------------------------------------------------------------
-- Policy anniversaries -- the natural moment for a review, and for term plans
-- the moment before a rate step-up.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Premiums falling due.
-- ---------------------------------------------------------------------------

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

comment on view v_premiums_due is
  'Premiums with a known next due date. Negative days_away means already overdue -- worth a call before it lapses.';

-- ---------------------------------------------------------------------------
-- Clients who have gone quiet, measured against the cadence you set per client
-- rather than one blanket rule.
-- ---------------------------------------------------------------------------

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

comment on view v_clients_gone_quiet is
  'Clients past their own review cadence. days_overdue of 9999 means never contacted since being added.';

-- ---------------------------------------------------------------------------
-- Open promises. The ones with a due date in the past are the ones that cost
-- you trust.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Policies with no review on record in over a year. Quiet risk: these are the
-- ones where cover has drifted out of line with the client's life.
-- ---------------------------------------------------------------------------

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
