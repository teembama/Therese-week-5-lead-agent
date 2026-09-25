-- Koya Lead Studio: database schema (reference; do not run against the existing database).
--
-- HOW THIS FILE WAS MADE (2026-09-25)
-- Reconstructed from the live database's PostgREST/OpenAPI description (read-only), plus the
-- migrations in supabase/migrations. A pg_dump was not possible from the repository because
-- the database password is not part of the app's configuration.
--
--   Verified against the live database: tables, columns, types, NOT NULL, defaults, primary
--     keys, foreign keys (target table and column).
--   From migrations: lead_runs_status_check (applied: 'cancelled' rows exist).
--   NOT verified (not exposed by PostgREST): ON DELETE behaviour of foreign keys, other check
--     constraints, unique constraints (e.g. on users.username), secondary indexes, RLS status and
--     policies, triggers, grants. Where the app relies on one of these, it is marked "assumed".
--
-- To replace this file with an authoritative dump, run with the database connection string
-- (Supabase dashboard → Project Settings → Database):
--   supabase db dump --schema-only -f supabase/schema.sql
-- or
--   pg_dump --schema-only --no-owner --no-privileges --schema=public "$DATABASE_URL" > supabase/schema.sql
--
-- Access model: the app uses the service-role key for all queries, which bypasses RLS. Access
-- control is enforced in the API routes (src/app/api), not by RLS policies.

-- Users (seeded demo accounts; passwords are bcrypt hashes)
create table public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null,          -- assumed unique (login looks users up by username)
  password_hash text not null,
  role text not null,              -- 'researcher' | 'reviewer' | 'admin' (enforced by the app)
  display_name text not null,
  created_at timestamptz not null default now()
);

-- One research run
create table public.lead_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,                    -- the user who started the run; NO foreign key to users
  objective text not null,
  refined_icp jsonb,               -- ICP criteria, including search_plan
  lead_limit integer not null default 10,
  candidate_limit integer not null default 20,
  scrape_limit integer not null default 20,
  agent_turn_limit integer not null default 25,
  status text not null default 'running',
  error text,                      -- user-facing message (also used for non-error outcomes)
  estimated_cost numeric,
  actual_cost numeric,             -- Claude cost in USD reported by the Agent SDK
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),  -- also the heartbeat for stale-run recovery
  -- migrations/20260924230000_add_cancelled_run_status.sql
  constraint lead_runs_status_check check (status in ('running', 'completed', 'failed', 'cancelled'))
);

-- A company saved by a run (qualified or needs_review; not_qualified is no longer saved)
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.lead_runs (id),
  company_name text not null,
  company_domain text,             -- null for companies discovered without a website
  qualification_status text not null default 'needs_review',  -- 'qualified' | 'needs_review' ('not_qualified' in rows from before 2026-09-23)
  confidence numeric,
  fit_reasons jsonb,               -- string[]
  concerns jsonb,                  -- string[]
  source_urls jsonb,               -- string[]
  source_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Evidence for a lead (qualified leads only)
create table public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id),
  url text,
  source_type text,
  title text,
  summary text,
  relevant_evidence text,
  retrieved_at timestamptz not null default now()
);

-- Outreach drafts for a qualified lead (never sent by the app)
create table public.outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id),
  email_1_subject text,
  email_1_body text,
  email_1_personalization text,
  email_2_subject text,
  email_2_body text,
  email_2_personalization text,
  email_3_subject text,
  email_3_body text,
  email_3_personalization text,
  linkedin_message text,
  status text not null default 'draft',  -- 'draft' | 'approved'
  created_at timestamptz not null default now()
);

-- Application audit log: tool calls observed by the app, agent notes, human actions
create table public.agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.lead_runs (id),
  tool_name text not null,         -- tool name, 'agent_note', 'manual_review', 'manual_approval', 'manual_cancel'
  purpose text,
  input_summary text,
  result_summary text,
  status text not null default 'success',  -- 'success' | 'error'
  error_message text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

-- Pending migrations (in supabase/migrations, not yet applied to the live database when this
-- file was written):
--   20260925120000_leads_unique_run_domain.sql
--     create unique index leads_run_domain_unique on public.leads (run_id, lower(company_domain))
--       where company_domain is not null and company_domain <> '';
--   20260925120100_one_running_run_per_user.sql
--     create unique index lead_runs_one_running_per_user on public.lead_runs (user_id)
--       where status = 'running' and user_id is not null;
--   20260925130000_outreach_rejection_regeneration.sql
--     outreach_drafts: + rejection_reason, rejected_by, rejected_at, regenerated_from (fk to
--       outreach_drafts.id), regeneration_direction; status check ('draft', 'approved', 'rejected');
--       unique index outreach_drafts_one_regeneration_per_lead on (lead_id) where regenerated_from is not null
