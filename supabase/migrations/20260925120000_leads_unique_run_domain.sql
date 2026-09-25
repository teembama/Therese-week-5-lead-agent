-- One lead per company domain within a run (database-level duplicate protection).
--
-- Why: save_lead checks for an existing lead before inserting, but two concurrent saves can both
-- pass that check. This index makes the database reject the second insert; the app reports it
-- as a duplicate (unique_violation 23505 → DuplicateLeadError in src/lib/agent.ts).
--
-- Nulls: company_domain is null for companies discovered without a website. Those rows are
-- excluded (partial index), so any number of domain-less leads may exist in a run; they are
-- deduplicated by name in the application. Empty strings are excluded the same way.
-- lower(): the app stores normalized lowercase domains, but older rows may not be.
--
-- Before applying, check that no run already has two leads with the same domain (the index
-- cannot be created otherwise). This should return no rows:
--
--   select run_id, lower(company_domain), count(*)
--     from public.leads
--    where company_domain is not null and company_domain <> ''
--    group by 1, 2
--   having count(*) > 1;
--
-- Safe to run more than once. Changes no data.

create unique index if not exists leads_run_domain_unique
  on public.leads (run_id, lower(company_domain))
  where company_domain is not null and company_domain <> '';
