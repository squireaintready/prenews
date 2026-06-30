# Crowdtells

**A living record of what the crowd believes.** The crowd tells it first.

Crowdtells is a news platform that uses **prediction markets as an assignment desk** — the money on
**Polymarket** and **Kalshi** flags what's worth covering (volume is interest, a 24h surge is breaking
interest, the odds are the market's read) — then briefs each story with real, **cross-source
reporting**: what outlets agree on, where they differ, and how each one frames it. The journalism
leads; the market data is the "why this matters."

Its moat is **time**: Crowdtells keeps a record of what the crowd believed at each point as a story
developed — the market's read _and_ the community's read on one timeline — so you can see not just
where opinion stands now, but where it stood then, and how it moved.

And it holds itself accountable: readers stake scored predictions, the platform grades its own reads,
and disputed claims get community notes that surface only when people who usually disagree both find
them helpful.

It is **100% free to run**: no servers, no paid APIs — a static site plus free tiers of a few managed
services (Supabase, Mailgun, Cloudflare). A GitHub Action does the work on a schedule and publishes to
Cloudflare Pages.

➡️ **Live:** https://crowdtells.com/

---

## How it works

```
        ┌───────────────── GitHub Actions · "Pulse Pipeline" (cron) ──────────────────┐
        │                                                            Groq (LLM)         │
 Polymarket ┐   dedup +          news-led           Google News      cross-source        │
 Kalshi ────┼─▶ fold props ·   ─▶ ranking ─────────▶ (real outlets ─▶ briefing JSON       │
        │   │   cluster STORIES   (footprint-led)     per story)          │              │
        │   ▼                                                             ▼              │
        │  merge with prior state (odds history · 24h/7d movement · revisions)           │
        │   │            │                       │                                       │
        │   │   score settled "Calls"   ingest world Events    write OG cards · RSS ·     │
        │   │   (Brier) + note bridging  (USGS, ESPN, NWS…)    sitemaps · /s/ · hubs      │
        │   │            │                       │                     │                 │
        │   ├──▶ store.json ──▶ `data` branch (durable cross-run state)                   │
        │   └──▶ public/feed.json ──▶ Vite build ──▶ wrangler ──▶ Cloudflare Pages        │
        └───────────────────────────────────────────────────────────────────────────────┘

 Daily/weekly digests + breaking alerts ──▶ Mailgun        (no API keys ever reach the client)
 Browser ──▶ static site ──▶ fetch feed.json + optional Supabase (accounts, comments, Calls)
```

### The selection algorithm

A news product can't just sort by volume. Crowdtells folds the raw market catalog into **stories** and
ranks them on **newsworthiness** — corroborated real-world coverage, not betting volume:

- **Stories, not markets** — page the top Polymarket + Kalshi candidates, drop illiquid / settled /
  far-dated novelty, then **fold recurring & price props** (the rolling "Elon # tweets" series, daily
  price ticks, "… - Total Corners" sub-lines) into demoted digests, and **cluster** the rest into
  stories: a conservative shared-entity rule plus an **LLM-confirmed news-coverage bridge** groups the
  many contracts trading on one development (the US–Iran deal, the Hormuz reopening, the Lebanon
  withdrawal) into a single story, with the others attached as "sub-signals." (`scripts/lib/stories.ts`)
- **News-led ranking** — a story's **news footprint** (the count of distinct, corroborating outlets
  actually reporting it) is the **primary** ranking axis; market volume is demoted to a damp-only gate
  (deep money can't push an unreported betting line above covered news), a sharp odds swing is a
  breaking-news backstop, and routine sports get a hard slot cap. MMR diversity + a day-to-day churn
  term keep the feed varied and fresh. (`scripts/lib/ranking.ts`)
- **Editorial desks** — each story is assigned a **format** — _feature_, _update_ (leads with what's
  new), _explainer_ (background-led), _result_ (past-tense recap), or _digest_ (the no-AI "on the
  board" row for folded props/sports) — so the feed reads like a varied newsroom, not one template 300×.
- **Cross-platform twins** — the same question on Polymarket and Kalshi is matched and collapsed,
  carrying the rival platform's price and a computed divergence. (`scripts/lib/canonical.ts`)
- **News** — Google News per story, **one citation per outlet** for perspective diversity, social /
  video / aggregator / trading-platform domains filtered out, capped at a handful of reputable
  outlets. (`scripts/lib/news.ts`)
- **Briefings** — pooled free LLMs ([Gemini](https://ai.google.dev) preferred, [Groq](https://groq.com)
  fallback; both OpenAI-compatible, JSON mode), grounded **strictly** in the retrieved headlines + the
  market's resolution rules. The model never sees or types live numbers — odds, volume, and gaps are
  hydrated at render time, so prose can't disagree with the market or hallucinate a figure. Rotates
  across both providers' keys **and** models on rate limits. (`scripts/lib/groq.ts`)

> The cross-source analysis works at the multi-outlet **headline/framing** level (article bodies
> aren't reliably fetchable through news aggregators); it surfaces consensus and differing emphasis
> well.

## What's in the product

- **Story feed + briefings** — related markets are grouped into one story, then given an article-shaped,
  sectioned briefing with a labeled editorial take, cited sources, a "Market Lens," and **"the crowd's
  read across this story"** (the absorbed sub-markets, each with its own odds). Routine props and sports
  collapse into quiet **"on the board"** rows instead of full articles. Every briefed story gets a
  permanent, shareable, crawlable `/s/<id>` page.
- **"Developing" live-wire** — a tabbed, minimizable widget of corroborated cross-newsroom news plus a
  global **Events** layer fed by ~10 free sources (USGS earthquakes, GDACS/ReliefWeb disasters, ESPN,
  NWS severe weather, Wikipedia Current Events, an economic calendar, PandaScore esports). Labeled
  "Developing," never "Breaking," and items deep-link into the matching briefing. (`scripts/lib/events.ts`)
- **The Calibration Desk** — signed-in readers stake immutable predictions ("Calls") on open markets;
  when a market settles, the pipeline grades each Call with a **Brier score** and the platform scores
  its own published reads by the same rule. Earned, decaying **trust tiers**, badges, a calibration
  panel, and **bridged community notes** (helpfulness judged by cross-viewpoint agreement, modeled on
  X's Community Notes — so same-side pile-ons can't promote a note). (`src/lib/gamify.ts`,
  `scripts/lib/scoring.ts`, `scripts/lib/bridging.ts`)
- **Community & accounts** — Google sign-in or email magic link, threaded comments, per-claim
  fact/opinion polling, saves and followed topics with cross-device cloud sync, and self-serve data
  export + account deletion.
- **Newsletter & alerts** — double-opt-in newsletter with daily/weekly cohorts plus a high-signal
  breaking-alert sender, all on one first-party Mailgun pipeline.
- **Themes & design** — an editorial "ink on paper" design in three themes (Light default, Bordeaux,
  Forest), self-hosted fonts, and an animated Source-Serif wordmark.

## Tech stack

| Layer       | Choice                                                            |
| ----------- | ----------------------------------------------------------------- |
| Frontend    | React 19 + TypeScript (strict), Vite, CSS Modules                 |
| Pipeline    | TypeScript (run with `tsx`) in GitHub Actions                     |
| AI          | Pooled free LLMs — Gemini + Groq (OpenAI-compatible, JSON mode), provider × model pool |
| Data        | Polymarket Gamma API · Kalshi API · Google News RSS · ~10 event sources |
| Backend     | Supabase (Postgres + RLS + Auth + Realtime + Edge Functions), optional |
| Email       | Mailgun (digests + alerts in CI; auth + confirm via Supabase Edge Functions) |
| Persistence | `feed.json` (published) + `store.json` (`data` branch)            |
| Hosting     | Cloudflare Pages (deployed via `wrangler`), custom domain + HTTPS |
| Quality     | ESLint, Prettier, Vitest (82 test files, 948 cases), CI gate     |

## Local development

```bash
npm install
npm run seed          # writes a realistic sample public/feed.json
npm run dev           # http://localhost:5173/

# validate the live pipeline without any API key (markets + news only):
npm run generate:dry

# quality gates (the same ones CI enforces before every deploy)
npm run typecheck && npm run lint && npm run test && npm run build
```

## Deployment

The **`.github/workflows/pipeline.yml`** ("Pulse Pipeline") runs on a market-aware cron (frequent
during U.S. market hours, sparser overnight/weekends) and on `workflow_dispatch`. Each run generates
fresh data, scores any settled Calls, optionally rebuilds, and deploys `dist/` to **Cloudflare Pages**
via `cloudflare/wrangler-action` (`pages deploy dist --project-name=crowdtell`). Durable cross-run
state is force-pushed to the `data` branch. Other workflows: **`ci.yml`** (typecheck + lint + test +
build on PRs), **`digest.yml`** (daily + weekly newsletter cron), and **`breaking.yml`** (breaking
alerts, gated on `BREAKING_ALERTS_ENABLED`).

Minimal setup is just one LLM key — without it the feed still ships real markets + real news links, and
briefings turn on once set. The pipeline pools two free providers (**Gemini** preferred, **Groq**
fallback), so either alone works and setting both adds capacity. Grab a free
[Gemini](https://aistudio.google.com/apikey) or [Groq](https://console.groq.com) key:

```bash
gh secret set GEMINI_API_KEYS  # Gemini (Google AI Studio); preferred for briefing prose
gh secret set GROQ_API_KEYS    # Groq "gsk_…"; fallback + extra free capacity (comma-separate to rotate)
```

Deploying to Cloudflare Pages additionally needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

### Actions **secrets** and **variables**

The workflow files are the source of truth; the common ones:

| Kind     | Name                                          | Purpose                                        |
| -------- | --------------------------------------------- | ---------------------------------------------- |
| secret   | `GEMINI_API_KEYS` / `GEMINI_API_KEY`          | Gemini key(s); preferred briefing provider     |
| secret   | `GROQ_API_KEYS` / `GROQ_API_KEY`              | Groq key(s); fallback + extra free capacity     |
| secret   | `CLOUDFLARE_API_TOKEN` · `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Pages deploy                      |
| secret   | `SUPABASE_SERVICE_KEY`                         | Server-side writes (scoring, sync, digests)    |
| secret   | `MAILGUN_API_KEY`                             | Sending digests + breaking alerts + confirmations |
| secret   | `MAILGUN_DOMAIN`                              | Mailgun sending domain (digests, alerts, auth)    |
| secret   | `FINNHUB_API_KEY` · `PANDASCORE_TOKEN`        | Optional event sources (financial, esports)    |
| secret   | `ALERT_WEBHOOK`                               | Optional webhook alert — feed-sync failure + Gemini falling back to Groq |
| secret   | `OPS_ALERT_EMAIL`                             | Optional — email alert (via Mailgun) when Gemini hits its limit |
| variable | `BASE_PATH`                                   | `/` for the custom domain                       |
| variable | `VITE_SUPABASE_URL` · `VITE_SUPABASE_ANON_KEY` | Client Supabase (anon key is public; RLS protects data) |
| variable | `VITE_GOOGLE_CLIENT_ID`                       | Google sign-in                                 |
| variable | `VITE_NEWSLETTER_ENABLED`                     | Show the newsletter UI                         |
| variable | `VITE_REALTIME_FEED` · `FEED_SYNC_ENABLED`    | Model B realtime data layer (off by default)   |
| variable | `RELIEFWEB_APPNAME`                           | Optional ReliefWeb disasters source            |

### Generator configuration (env, all optional)

Sensible defaults live in [`scripts/lib/config.ts`](scripts/lib/config.ts); override via env. The most
useful:

| Variable               | Default                   | Purpose                                   |
| ---------------------- | ------------------------- | ----------------------------------------- |
| `GEMINI_MODELS`        | `2.5-flash`, `flash-lite` | Comma-separated Gemini models to cycle     |
| `GEMINI_REASONING_EFFORT` | `none`                 | Gemini thinking: `none`/`low`/`medium`/`high` |
| `GROQ_MODELS`          | 3-model pool              | Comma-separated Groq models to cycle      |
| `POLYMARKET_LIMIT`     | `100`                     | Polymarket candidates before ranking      |
| `KALSHI_LIMIT`         | `80`                      | Kalshi candidates before ranking (0 off)  |
| `KALSHI_PER_CATEGORY`  | `3`                       | Kalshi candidates kept per category       |
| `FEED_SIZE`            | `72`                      | Stories kept in the live feed             |
| `DIVERSITY`            | `0.15`                    | MMR penalty per repeated category         |
| `SOURCE_DIVERSITY`     | `0.04`                    | MMR penalty per repeated platform         |
| `KALSHI_BOOST`         | `0.1`                     | Selection bonus for Kalshi                |
| `MIN_VOLUME`           | `10000`                   | Drop markets below this total volume      |
| `GENERATE_LIMIT`       | `20`                      | New briefings generated per run           |
| `NEWS_PER_MARKET`      | `8`                       | Distinct outlets retrieved per story      |
| `EVENTS_MAX`           | `30`                      | Cap on the global Events strip            |
| `RESOLVED_RETAIN_DAYS` | `14`                      | How long resolved stories stay in "Past"  |
| `ARCHIVE_RETAIN_DAYS`  | `1095`                    | How long a briefed `/s/` page is retained |

## Accounts, community & the Calibration Desk (Supabase)

Accounts, comments, likes, claim polls, the Calibration Desk (Calls, scoring, trust, bridged notes),
saves/interests sync, and the newsletter are powered by [Supabase](https://supabase.com) (free tier)
and are **optional** — the site runs fine without them, and `supabase-js` is lazy-loaded (and
tree-shaken out entirely when unconfigured), so the reading path stays light. To turn them on:

1. Create a free Supabase project, open the **SQL Editor**, and run
   [`supabase/schema.sql`](supabase/schema.sql) (tables + Row-Level Security + rate limiting +
   auto-profiles + the Calibration Desk). Re-run it after pulling schema changes.
2. **Auth → Providers → Google:** enable it and add a Google OAuth client
   ([console.cloud.google.com](https://console.cloud.google.com)). Add `https://crowdtells.com/` under
   **Auth → URL Configuration → Redirect URLs**. Email magic-link works with no extra setup.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository **variables** (the anon key is a
   public client credential, safe to expose — RLS protects the data). The next deploy enables the UI.

An operator **admin console** (`?admin`) ships behind a server-enforced allowlist — see
[`docs/admin-panel.md`](docs/admin-panel.md); grant access with `npm run admin:grant -- --email …`.

Best practices baked in: RLS on every table, writes scoped to `auth.uid()`, secret-ballot voting via
aggregate-only RPCs, a comment rate-limit trigger, report/flag + author-delete, length validation, and
immutable Calls + bridging so the public track record can't be gamed. Share links use `?s=<id>` and
deep-link to a story.

## Email (Mailgun + Supabase Edge Functions)

All mail goes out through one first-party Mailgun pipeline (click-tracking off, so links stay on
`crowdtells.com`):

- **Auth + instant double-opt-in confirmation** are sent by Supabase **Edge Functions**
  (`supabase/functions/auth-email`, `send-confirm`) via a Supabase *Send Email Hook*, branded from
  `noreply@crowdtells.com`.
- **Digests + breaking alerts + pending confirmations** are sent per-recipient from the Actions jobs
  (`npm run digest` / `breaking` / `confirm`).

Both paths use `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` (Supabase function secrets for the edge functions;
Actions secrets for the CI senders). Step-by-step setup is in
[`docs/auth-email-hook.md`](docs/auth-email-hook.md),
[`docs/instant-confirm-edge-function.md`](docs/instant-confirm-edge-function.md),
[`docs/supabase-auth-emails.md`](docs/supabase-auth-emails.md), and
[`docs/one-click-unsubscribe.md`](docs/one-click-unsubscribe.md).

## Hosting & custom domain

The site is live on **Cloudflare Pages** at **crowdtells.com** (custom domain + automatic HTTPS, clean
URLs). The `data` branch is GitHub-only (it just stores `store.json`); deploys are driven by `wrangler`
from the Pulse Pipeline. `public/CNAME` is retained for portability. To point a new domain, add it in
the Cloudflare Pages project and to Supabase's redirect URLs (OAuth redirects adapt to the host
automatically); set the `BASE_PATH` variable to `/` so the app serves from the root.

## License

**Source-available, not open source.** Published openly for transparency under the
[PolyForm Noncommercial License 1.0.0](LICENSE) — free to use, modify, and share for
**noncommercial** purposes; **commercial use requires a separate license**.
© 2026 Samuel Jo ([@squireaintready](https://github.com/squireaintready)).
