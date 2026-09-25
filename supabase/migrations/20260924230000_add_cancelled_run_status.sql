-- Add 'cancelled' as a valid lead_runs.status.
--
-- Why: user cancellations were stored as 'failed', so a cancelled run looked like a system
-- failure. The existing check constraint (lead_runs_status_check) only allows
-- running / completed / failed, and rejects 'cancelled' (verified: insert fails with 23514).
--
-- One ALTER TABLE statement, so it is atomic on its own: if adding the new constraint failed,
-- the old one would not be dropped. No explicit BEGIN/COMMIT, so it also runs correctly under
-- `supabase db push` (which wraps each migration in its own transaction) and in the SQL editor.
--
-- Safe to run more than once. Does not modify any rows: every existing status (running,
-- completed, failed) satisfies the new constraint, so validation of existing rows succeeds.
-- Until it is applied, the app still cancels runs but stores them as 'failed' with the
-- cancellation message (see src/lib/cancel-run.ts).

alter table public.lead_runs
  drop constraint if exists lead_runs_status_check,
  add constraint lead_runs_status_check
    check (status in ('running', 'completed', 'failed', 'cancelled'));

-- Optional, changes data — run only if you want past cancellations relabelled.
-- Before this change, a user cancellation was stored as status 'failed' with the message
-- 'Cancelled by user'. This relabels exactly those rows (2 at the time of writing):
--
-- update public.lead_runs
--    set status = 'cancelled'
--  where status = 'failed'
--    and error = 'Cancelled by user';
