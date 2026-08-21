# Outreach Engine

AI-powered outreach system for outsourcing services. Finds the right contact at a company that's hiring, researches the company, writes a personalized email, waits for your approval, sends it, follows up twice, and routes replies to you.

**Every email is approved by a human before it sends.** That is not a setting.

---

## What it costs

| Item | Monthly |
|---|---|
| DigitalOcean droplet (2GB / 2vCPU) | $18 |
| Claude API (hard-capped in software) | ≤$20 |
| Google Workspace × 4 inboxes | $28 |
| Smartlead (inbox rotation + warm-up) | $39 |
| Hunter (email finding + verification) | $49 |
| Domains (amortized) | ~$1 |
| **Total** | **~$155** |

PostgreSQL is self-hosted in Docker (saves $25/mo vs managed), auth is self-hosted (saves $25/mo), and the job queue is Postgres rather than Redis (saves a service). The AI budget is enforced in code — it cannot overrun.

---

## Architecture

```
┌─────────────┐   ┌─────────────┐   ┌──────────────┐
│    caddy    │──▶│     web     │   │    worker    │
│  auto-TLS   │   │  Next.js    │   │  background  │
└─────────────┘   └──────┬──────┘   └──────┬───────┘
                         │                  │
                         └────────┬─────────┘
                                  ▼
                         ┌──────────────────┐
                         │   PostgreSQL 16  │
                         │  + job queue     │
                         └──────────────────┘
```

Both `web` and `worker` run the **same image** — they cannot drift out of sync.

### Provider abstraction

Every third-party service sits behind an interface. Swapping a provider is a new class plus one environment variable — no route, job, or component changes.

| Interface | Implementations | File |
|---|---|---|
| `AiService` | Anthropic | `src/lib/providers/ai/` |
| `EmailService` | Resend, Smartlead, Console | `src/lib/providers/email/` |
| `EnrichmentService` | Hunter, Noop | `src/lib/providers/enrichment/` |
| `JobQueue` | Postgres | `src/lib/providers/queue/` |

This is what makes the scaling path a config change:

- **Phase 1** (50–100/day): Resend, 1 domain, 1 inbox
- **Phase 2** (200–500/day): add domains + inboxes from the dashboard
- **Phase 3** (500–2000/day): `EMAIL_PROVIDER=smartlead`, nothing else changes

---

## Running it locally (no Docker, no Postgres install)

`scripts/local-db.mjs` runs PGlite — real PostgreSQL compiled to WebAssembly — and exposes it on a TCP port speaking the Postgres wire protocol. The app connects to it exactly as it would to a normal server, so no application code knows the difference.

Three terminals:

```bash
npm run local:db
```

```bash
npm run dev
```

```bash
npm run worker:dev
```

First time only, in a fourth terminal:

```bash
npm run db:migrate
```

```bash
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='a-long-password' npm run db:seed
```

Optional — populates leads, emails, replies, domains, and notifications so every page renders with real content instead of empty states. Safe to re-run; it clears its own rows first:

```bash
npm run local:demo
```

Two `.env` values matter only for this local setup and must **not** be carried to production:

- `DB_POOL_MAX=1` — the WASM Postgres executes serially, so a small pool avoids resets. Omit it in production.
- `SEND_WINDOW_START_HOUR` / `END_HOUR` — widen these if you want to watch a send complete outside business hours. Production should keep 9–17, because cold email sent at 3am reads as automated.

---

## First deploy

### 1. Provision the droplet

DigitalOcean → Create Droplet → Ubuntu 24.04, **2GB RAM / 2 vCPU** ($18/mo), any region near your prospects.

```bash
ssh root@YOUR_DROPLET_IP
```

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. Point DNS at it

At your registrar, create an **A record** for your app domain (e.g. `app.yourcompany.com`) pointing to the droplet IP. Caddy needs this resolving before it can issue a TLS certificate.

### 3. Get the code onto the server

```bash
git clone YOUR_REPO_URL /opt/outreach && cd /opt/outreach
```

### 4. Configure

```bash
cp .env.example .env
```

Then edit `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `POSTGRES_PASSWORD` | Generate: `openssl rand -base64 24` |
| `NEXTAUTH_SECRET` | Generate: `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `RESEND_API_KEY` | resend.com → API Keys |
| `HUNTER_API_KEY` | hunter.io → API |
| `APP_DOMAIN` | Your app domain, e.g. `app.yourcompany.com` |
| `APP_URL` | `https://` + the above |
| `ALERT_EMAIL_TO` | Where Tier-3 alerts go — your real inbox |

**Never commit `.env`.** It is gitignored and excluded from the Docker image.

### 5. Start

```bash
docker compose up -d --build
```

Migrations run automatically before the app boots.

### 6. Create your account

```bash
docker compose exec web sh -c 'SEED_ADMIN_EMAIL=you@yourcompany.com SEED_ADMIN_PASSWORD="a-long-strong-password" SEED_ORG_NAME="Your Company" npx tsx src/db/seed.ts'
```

Open `https://app.yourcompany.com` and sign in.

---

## After deploy: sending setup

Sending will not work until you complete this — deliberately.

### 1. Buy sending domains

Buy 2 domains that are **variations of your real brand** (Cloudflare Registrar is cheapest). Prospects who look them up should recognise your company. Never send cold email from your primary domain.

### 2. Create mailboxes

Google Workspace → add each domain → create 2 mailboxes per domain (e.g. `outreach@`, `team@`). That's 4 inboxes for ~$28/mo.

### 3. Add DNS records

For each sending domain, add the SPF, DKIM, and DMARC records Google Workspace gives you.

Minimum DMARC to start with:

```
_dmarc.yourdomain.com   TXT   "v=DMARC1; p=none; rua=mailto:you@yourdomain.com"
```

### 4. Register them in the dashboard

**Sending → Domains & inboxes → + Add domain.** The system checks SPF/DKIM/DMARC live and tells you exactly what's missing. Once all three pass, warm-up starts automatically.

Then **+ Inbox** on each domain for each mailbox you created.

### 5. Wait

Warm-up takes about 6 weeks per inbox: starts at 10/day, roughly doubles weekly, ends at your configured maximum. **This cannot be skipped** — it's the single most common way to burn a domain. The ramp advances automatically each night.

By week 6 you're at ~400–600/day across 4 inboxes.

---

## Daily use

Roughly 15 minutes:

1. **Import leads** — Leads → Import CSV. Needs an email column and a company/domain column. Duplicates are skipped, so re-importing is safe.
2. **Research** — click Research on leads worth pursuing. Cached per company, so 5 contacts at one company cost one call.
3. **Generate** — click Generate email on researched leads.
4. **Approve** — the Approval queue. Read, edit inline if needed, select all, approve. This is the 10-minute part.
5. **Handle replies** — anything classified `interested` alerts you by email and appears under "Leads requiring attention". You reply from your own inbox; the AI never answers on your behalf.

Follow-ups are drafted automatically when due and land in the same approval queue. Maximum 2 per lead, then the sequence stops.

---

## Cost control

The AI budget is enforced in `src/lib/ai/budget.ts` before every call:

- **Warn at $16** — notification, work continues
- **Stop at $20** — every AI call is refused

Both thresholds are editable at **Settings → AI configuration** with no redeploy. Spend is a `SUM` over the `ai_usage` table, so a restart cannot reset it.

Model assignment per operation is also editable there. Defaults:

| Operation | Model | Why |
|---|---|---|
| Research | Haiku 4.5 | Cheap, cached, runs often |
| Email generation | Sonnet 5 | Quality matters most here |
| Follow-up | Haiku 4.5 | Short, formulaic |
| Reply classification | Haiku 4.5 | Classification, not writing |

---

## Self-healing

Three tiers, defined in `src/lib/notifications.ts`:

| Tier | Behaviour | Example |
|---|---|---|
| **1 — auto-fixed** | Logged, silent | Stalled job reclaimed; interrupted send re-queued |
| **2 — auto + notify** | Handled, dashboard notice | Daily cap hit; unsubscribe honoured |
| **3 — stopped** | Dashboard **and** email, immediately | Budget exhausted; API key invalid; inbox paused for reputation |

The system never routes around a block. If a provider pushes back, it stops and asks — it does not try to evade.

---

## Operations

```bash
docker compose logs -f worker
```

```bash
docker compose ps
```

```bash
docker compose restart worker
```

Deploy an update:

```bash
cd /opt/outreach && git pull && docker compose up -d --build
```

Backups run nightly into `./backups` (14-day retention). Restore:

```bash
docker compose exec -T db pg_restore -U outreach -d outreach --clean < backups/YOUR_BACKUP.dump
```

---

## Security

- All secrets are server-side environment variables. Nothing is exposed to the browser.
- `.env` is gitignored and dockerignored — never baked into the image.
- Postgres is not published to the host; only app containers reach it.
- Passwords are bcrypt (cost 12).
- Every API route calls `requireAuth()` and scopes queries by `organizationId`.
- The email webhook verifies its HMAC signature before touching the database.
- All mutations are written to `audit_logs`.

---

## Project layout

```
src/
├── db/
│   ├── schema.ts          23 tables, the source of truth
│   ├── migrations/        versioned SQL, generated by drizzle-kit
│   └── seed.ts            first-run bootstrap
├── lib/
│   ├── providers/         ← all third-party code lives behind these interfaces
│   ├── ai/                budget, config, prompts, the 4 operations
│   ├── sending/           inbox rotation, warm-up ramp, DNS checks
│   ├── notifications.ts   three-tier alerting
│   └── auth.ts
├── worker/
│   ├── index.ts           poll loop, graceful shutdown, recurring schedule
│   └── handlers/          one file per job type
├── app/
│   ├── api/               23 routes
│   └── (pages)
└── components/
```

### Common tasks

```bash
npm run db:generate
```

Typecheck plus a raw-SQL enum audit. The audit exists because TypeScript cannot check string literals inside a `sql` template — a value from the wrong enum compiles cleanly and only fails at runtime with a Postgres `enum_in` error. Run this before every deploy:

```bash
npm run verify
```

```bash
npm run worker:dev
```
