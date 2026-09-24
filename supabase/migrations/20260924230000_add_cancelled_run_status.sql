-- Add 'cancelled' as a valid lead_runs.status.
--
-- Why: user cancellations were stored as 'failed', so a cancelled run looked like a system
-- failure. The existing check constraint (lead_runs_status_check) only allows
-- running / completed / failed, and rejects 'cancelled' (verified: insert fails with 23514).
--
-- Safe to run more than once. Does not modify any existing rows. Run it in the Supabase
-- SQL editor (or `supabase db push`). Until it is applied, the app still cancels runs but
-- stores them as 'failed' with the cancellation message (see src/lib/cancel-run.ts).

begin;

alter table public.lead_runs drop constraint if exists lead_runs_status_check;

alter table public.lead_runs
  add constraint lead_runs_status_check
  check (status in ('running', 'completed', 'failed', 'cancelled'));

commit;

-- Optional, changes data — run only if you want past cancellations relabelled.
-- Before this change, a user cancellation was stored as status 'failed' with the message
-- 'Cancelled by user'. This relabels exactly those rows (2 at the time of writing):
--
-- update public.lead_runs
--    set status = 'cancelled'
--  where status = 'failed'
--    and error = 'Cancelled by user';
