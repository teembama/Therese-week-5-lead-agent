-- At most one running run per user (database-level backstop for POST /api/runs).
--
-- Why: POST /api/runs rejects a new run with 409 when the user already has one running, but two
-- simultaneous requests can both pass that check. This index makes the database reject the
-- second insert; the route turns unique_violation (23505) into the same 409.
-- The app check works without this migration; this closes the race.
--
-- Rows with a null user_id are excluded. Before applying, this should return no rows:
--
--   select user_id, count(*) from public.lead_runs
--    where status = 'running' and user_id is not null
--    group by 1 having count(*) > 1;
--
-- Safe to run more than once. Changes no data.

create unique index if not exists lead_runs_one_running_per_user
  on public.lead_runs (user_id)
  where status = 'running' and user_id is not null;
