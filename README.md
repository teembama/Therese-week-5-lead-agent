# Koya Lead Studio

Koya Lead Studio is an AI lead-research agent. You describe the companies you want and why; it searches LinkedIn, researches each company's own website, keeps only the companies that fit with cited evidence, and drafts a 3-email sequence plus a LinkedIn message for each one. Every draft waits for human review. Nothing is ever sent, and personal email addresses are never looked up.

Full architecture, limits, tools and failure handling: **[SYSTEM_DOCS.md](SYSTEM_DOCS.md)**.

## Requirements

- Node.js **20.9 – 22.x** (see `engines` in `package.json`)
- A Supabase project with the app's tables (`lead_runs`, `leads`, `lead_sources`, `outreach_drafts`, `agent_tool_calls`, `users`)
- API keys for Anthropic, Apify (with access to `harvestapi/linkedin-company-search`) and Firecrawl

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` in the project root (it is gitignored; never commit it):

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service-role key>
   ANTHROPIC_API_KEY=<key>
   APIFY_API_TOKEN=<token>
   FIRECRAWL_API_KEY=<key>
   SESSION_SECRET=<random string, at least 32 characters>

   # Optional: Discord notifications when a run completes or a lead is promoted
   DISCORD_WEBHOOK_URL=<Discord webhook URL>
   # Optional: public address used for run links in those notifications
   APP_URL=https://<your app domain>
   ```

   A session secret can be generated with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

3. Apply the database migration in the Supabase SQL editor (or with `supabase db push`):

   ```
   supabase/migrations/20260924230000_add_cancelled_run_status.sql
   ```

   It lets `lead_runs.status` store `cancelled`. It changes no rows and is safe to run more than once.

4. Create user accounts in the `users` table (`username`, bcrypt `password_hash`, `role` of `researcher`, `reviewer` or `admin`, `display_name`). Use strong, unique passwords.

## Run locally

```bash
npm run dev        # http://localhost:3000
npm test           # unit tests (no network, no cost)
npx tsc --noEmit   # typecheck
npm run lint
npm run build && npm start   # production build
```

Local runs use real Apify, Firecrawl and Claude credits: a 3-lead run typically costs well under $1 of model usage plus a few cents of Apify.

## Deploy to Railway

1. Create a Railway service from this repository. Railway detects Next.js and runs `npm run build` and `npm start`; no extra configuration file is needed.
2. Set the six required environment variables above in the service's **Variables** tab (plus `DISCORD_WEBHOOK_URL` if you want notifications; run links use Railway's public domain unless `APP_URL` is set). `NEXT_PUBLIC_SUPABASE_URL` must be set before the build, because Next.js inlines it at build time.
3. Apply the database migration (step 3 above) to the production Supabase project.
4. Deploy. On each start the app marks runs orphaned by the previous process as failed ("stopped unexpectedly") once they have had no heartbeat for 35 minutes.

## Roles

- **researcher**: starts runs, can cancel their own runs, and can regenerate rejected outreach (once per lead)
- **reviewer**: promotes needs-review leads (with a reason), and approves or rejects outreach
- **admin**: everything, including cancelling any run
