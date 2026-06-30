/**
 * Operations telemetry sink for the Pulse Pipeline. End-of-run, the generator hands us a
 * PipelineRunSummary; we (1) persist it to Supabase (`pipeline_runs`) for the admin
 * Operations console, and (2) alert (webhook + email) on a Gemini availability TRANSITION —
 * healthy↔down — so the owner is notified once, not spammed every run.
 *
 * Everything here is BEST-EFFORT: any failure is logged and swallowed so observability can
 * never break a pipeline run. All credentials are read from env (matching the send-* tools),
 * so the whole module is inert until the owner configures Supabase / ALERT_WEBHOOK / Mailgun.
 */
import { randomUUID } from 'node:crypto';
import { adminCtxFromEnv, restUpsert, restSelect, restDelete, type AdminCtx } from './admin';
import type { PipelineRunSummary } from '../../src/lib/types';

/** The promoted columns we index/filter on + the full summary as jsonb `detail`. */
interface PipelineRunRow {
  id: string;
  run_at: string;
  duration_ms: number;
  generated: number;
  skipped: number;
  results: number;
  briefed: number;
  gemini_down: boolean;
  commit_sha: string;
  run_id: string;
  detail: PipelineRunSummary;
}

const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const REPO = 'squireaintready/crowdtells';

function ctxOrNull(): AdminCtx | null {
  try {
    return adminCtxFromEnv();
  } catch {
    return null; // Supabase not configured → persist is a no-op (alerts still try).
  }
}

/**
 * Persist a run summary + alert on a Gemini health transition. Best-effort; never throws.
 */
export async function recordPipelineRun(summary: PipelineRunSummary): Promise<void> {
  const ctx = ctxOrNull();

  // 1) Alert on a state CHANGE only (needs the previous run's health). Done first so a
  //    persist failure can't suppress the notification.
  let prevDown = false;
  if (ctx) {
    try {
      const prev = await restSelect<{ gemini_down: boolean }>(
        ctx,
        'pipeline_runs',
        'select=gemini_down&order=run_at.desc&limit=1',
      );
      prevDown = prev[0]?.gemini_down ?? false;
    } catch {
      /* table missing (pre-migration) or unreachable → treat prior as healthy */
    }
  }
  await maybeAlertGeminiHealth(summary, prevDown);

  // 2) Persist this run, then prune anything older than the retention window.
  if (!ctx) return;
  try {
    const row: PipelineRunRow = {
      id: randomUUID(),
      run_at: summary.at,
      duration_ms: summary.durationMs,
      generated: summary.generated,
      skipped: summary.skipped,
      results: summary.results,
      briefed: summary.briefed,
      gemini_down: summary.geminiDown,
      commit_sha: summary.commit,
      run_id: summary.runId,
      detail: summary,
    };
    await restUpsert(ctx, 'pipeline_runs', [row]);
    const cutoff = new Date(Date.parse(summary.at) - RETENTION_DAYS * DAY_MS).toISOString();
    await restDelete(ctx, 'pipeline_runs', `run_at=lt.${cutoff}`).catch(() => []);
  } catch (err) {
    console.warn(`  ! pipeline_runs persist failed (non-fatal): ${(err as Error).message}`);
  }
}

/** Notify only when Gemini's availability flips, with a short, actionable message. */
async function maybeAlertGeminiHealth(summary: PipelineRunSummary, prevDown: boolean): Promise<void> {
  if (summary.geminiDown === prevDown) return; // no transition → stay quiet
  const link = summary.runId ? ` https://github.com/${REPO}/actions/runs/${summary.runId}` : '';
  if (summary.geminiDown) {
    const gemini = summary.llm.filter((u) => u.provider === 'gemini');
    const limited = gemini.reduce((n, u) => n + u.rateLimited, 0);
    const overloaded = gemini.reduce((n, u) => n + u.overloaded, 0);
    await sendOpsAlert({
      subject: '⚠️ Crowdtells: Gemini unavailable — briefings fell back to Groq',
      text:
        `Gemini produced 0 successful briefings this run (${limited} rate-limited, ` +
        `${overloaded} overloaded); every briefing used Groq. Quality may dip until ` +
        `Gemini recovers — you'll get an all-clear when it does.${link}`,
    });
  } else {
    await sendOpsAlert({
      subject: '✅ Crowdtells: Gemini recovered',
      text: `Gemini is writing briefings again.${link}`,
    });
  }
}

/** POST the alert webhook AND send a Mailgun email — independent + best-effort. */
export async function sendOpsAlert(alert: { subject: string; text: string }): Promise<void> {
  await Promise.allSettled([postWebhook(alert), sendEmail(alert)]);
}

async function postWebhook({ subject, text }: { subject: string; text: string }): Promise<void> {
  const url = (process.env.ALERT_WEBHOOK || '').trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${subject}\n${text}` }), // Slack/Discord-style {"text":…}
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn(`  ! ops webhook failed (non-fatal): ${(err as Error).message}`);
  }
}

async function sendEmail({ subject, text }: { subject: string; text: string }): Promise<void> {
  const apiKey = (process.env.MAILGUN_API_KEY || '').trim();
  const domain = (process.env.MAILGUN_DOMAIN || '').trim();
  const to = (process.env.OPS_ALERT_EMAIL || '').trim();
  if (!apiKey || !domain || !to) return; // not configured → skip the email half
  const base =
    (process.env.MAILGUN_REGION || 'us').toLowerCase() === 'eu'
      ? 'https://api.eu.mailgun.net'
      : 'https://api.mailgun.net';
  const from = (process.env.NEWSLETTER_FROM || `Crowdtells Ops <ops@${domain}>`).trim();
  const body = new URLSearchParams();
  body.set('from', from);
  body.set('to', to);
  body.set('subject', subject);
  body.set('text', text);
  body.set('o:tag', 'ops-alert');
  body.set('o:tracking', 'no');
  try {
    const res = await fetch(`${base}/v3/${domain}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.warn(`  ! ops email failed (non-fatal): ${res.status}`);
  } catch (err) {
    console.warn(`  ! ops email failed (non-fatal): ${(err as Error).message}`);
  }
}
