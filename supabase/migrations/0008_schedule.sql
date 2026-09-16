-- ============================================================================
-- 0008_schedule.sql
-- The alarm clock.
--
-- READ THIS BEFORE RUNNING: this file has two placeholders you must replace.
-- Search for YOUR-PROJECT-REF and YOUR-CRON-SECRET below. The setup guide in
-- docs/SETUP.md walks through where to find both.
--
-- Times are in UTC because that is what the database runs on. Singapore is
-- UTC+8, so 7:00am in Singapore is 23:00 UTC the previous day.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Store the secret that lets cron call the edge function. Keeping it in the
-- vault means it is encrypted at rest and does not appear in your cron job
-- definitions in plain text.
-- ---------------------------------------------------------------------------

select vault.create_secret(
  'YOUR-CRON-SECRET',          -- replace: same value as the CRON_SECRET function secret
  'crm_cron_secret',
  'Shared secret proving a scheduled call really came from pg_cron'
)
where not exists (
  select 1 from vault.secrets where name = 'crm_cron_secret'
);

-- ---------------------------------------------------------------------------
-- The morning briefing: 7:00am Singapore, every day.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'crm-morning-briefing',
  '0 23 * * *',                -- 23:00 UTC = 07:00 SGT next day
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/briefing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                         where name = 'crm_cron_secret')
    ),
    body    := jsonb_build_object('kind', 'morning'),
    timeout_milliseconds := 30000
  );
  $$
);

-- ---------------------------------------------------------------------------
-- Monday planning note: the week ahead, sent Sunday evening so you can plan
-- Monday before Monday happens.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'crm-week-ahead',
  '0 11 * * 0',                -- 11:00 UTC Sunday = 19:00 SGT Sunday
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/briefing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                         where name = 'crm_cron_secret')
    ),
    body    := jsonb_build_object('kind', 'week_ahead'),
    timeout_milliseconds := 30000
  );
  $$
);

-- ---------------------------------------------------------------------------
-- Monthly nudge to pull a fresh export from the company portal.
-- You do the export by hand -- those are your principal's credentials and
-- automating that login would put your licence at risk. This just makes sure
-- it does not slip your mind.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'crm-monthly-export-reminder',
  '0 1 1 * *',                 -- 01:00 UTC on the 1st = 09:00 SGT on the 1st
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/briefing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                         where name = 'crm_cron_secret')
    ),
    body    := jsonb_build_object('kind', 'export_reminder'),
    timeout_milliseconds := 30000
  );
  $$
);

-- ---------------------------------------------------------------------------
-- Housekeeping: conversation history older than 60 days is not worth keeping,
-- and trimming it keeps you inside the free tier comfortably.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'crm-trim-conversation-history',
  '30 18 * * *',               -- 18:30 UTC = 02:30 SGT, while you sleep
  $$
  delete from conversation_turns where created_at < now() - interval '60 days';
  $$
);

-- ---------------------------------------------------------------------------
-- To see what is scheduled:      select * from cron.job;
-- To see whether it ran:         select * from cron.job_run_details
--                                 order by start_time desc limit 20;
-- To turn the morning brief off: select cron.unschedule('crm-morning-briefing');
-- ---------------------------------------------------------------------------
