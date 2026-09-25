-- Outreach rejection and regeneration.
--
-- Adds to outreach_drafts:
--   rejection_reason, rejected_by, rejected_at   set when a reviewer rejects a draft
--   regenerated_from                             the rejected draft a regenerated draft replaces
--   regeneration_direction                       the researcher's direction for the regeneration
-- Allows status 'rejected' (alongside 'draft' and 'approved'), and allows at most one regenerated
-- draft per lead (partial unique index), so the one-regeneration limit also holds under
-- concurrent requests.
--
-- Before applying: the live schema's constraints are not visible through the REST API, so check
-- for an existing status check under another name (drop it if it does not allow 'rejected'):
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.outreach_drafts'::regclass and contype = 'c';
--
-- and that every existing row has a status the new check allows (should return no rows):
--
--   select status, count(*) from public.outreach_drafts
--    where status not in ('draft', 'approved', 'rejected') group by 1;
--
-- One statement per change; safe to run more than once. Changes no data.

alter table public.outreach_drafts
  add column if not exists rejection_reason text,
  add column if not exists rejected_by text,
  add column if not exists rejected_at timestamptz,
  add column if not exists regenerated_from uuid references public.outreach_drafts (id),
  add column if not exists regeneration_direction text;

alter table public.outreach_drafts
  drop constraint if exists outreach_drafts_status_check,
  add constraint outreach_drafts_status_check
    check (status in ('draft', 'approved', 'rejected'));

create unique index if not exists outreach_drafts_one_regeneration_per_lead
  on public.outreach_drafts (lead_id)
  where regenerated_from is not null;
