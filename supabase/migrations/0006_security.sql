-- ============================================================================
-- 0006_security.sql
-- Locks the front door.
--
-- Supabase projects ship with a public "anon" key that is embedded in browsers
-- and is not a secret. Row Level Security is what stops that key reading your
-- client list. Every table below has RLS on and NO policy, which means: the
-- anon and authenticated keys can read nothing and write nothing.
--
-- The edge functions use the service_role key, which bypasses RLS by design.
-- That key must never leave the server. It is set as a function secret, never
-- committed, and never sent to Telegram.
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

-- Deliberately no policies. Deny-by-default is the whole point.
-- If you later add a web dashboard with real user logins, add policies here
-- rather than loosening anything above.

-- ---------------------------------------------------------------------------
-- Keep the views honest. A view normally runs with its creator's privileges,
-- which would let it leak past RLS. security_invoker makes each view respect
-- the caller's permissions instead.
-- ---------------------------------------------------------------------------

alter view v_upcoming_birthdays    set (security_invoker = on);
alter view v_policy_anniversaries  set (security_invoker = on);
alter view v_premiums_due          set (security_invoker = on);
alter view v_clients_gone_quiet    set (security_invoker = on);
alter view v_open_actions          set (security_invoker = on);
alter view v_reviews_overdue       set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Revoke the default grants Supabase hands to the public roles, so that even a
-- future table-level mistake does not expose client data through PostgREST.
-- ---------------------------------------------------------------------------

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on functions from anon, authenticated;
