import { useMemo } from 'react';
import s from './AdminPanel.module.css';
import { useAdminQuery } from './useAdminQuery';
import { Banner, Empty, Loading } from './ui';
import { listPipelineRuns, type PipelineRunRow } from '../../lib/admin';
import type { LlmModelUsage } from '../../lib/types';

const LOAD = 100; // runs to pull (server caps at 500); ~2-3 days at peak cadence

// ───────── formatting ─────────
const int = (n: number | null | undefined): string => (n ?? 0).toLocaleString();
function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return `${n}`;
}
function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
function clockTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
function relTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return '';
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// ───────── aggregation ─────────
/** Sum every run's per-model LLM usage into one row per provider×model. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, unit-tested
export function aggregateLlm(runs: PipelineRunRow[]): LlmModelUsage[] {
  const map = new Map<string, LlmModelUsage>();
  for (const r of runs) {
    for (const u of r.detail?.llm ?? []) {
      const cur = map.get(`${u.provider}:${u.model}`);
      if (!cur) map.set(`${u.provider}:${u.model}`, { ...u });
      else {
        cur.requests += u.requests;
        cur.ok += u.ok;
        cur.rateLimited += u.rateLimited;
        cur.overloaded += u.overloaded;
        cur.failed += u.failed;
        cur.tokens += u.tokens;
        cur.latencyMsTotal += u.latencyMsTotal;
      }
    }
  }
  return [...map.values()].sort((a, b) => b.requests - a.requests);
}

const sumTokens = (r: PipelineRunRow): number => (r.detail?.llm ?? []).reduce((n, u) => n + u.tokens, 0);
const sumReq = (r: PipelineRunRow): number => (r.detail?.llm ?? []).reduce((n, u) => n + u.requests, 0);

// ───────── sparkline ─────────
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const w = 132;
  const h = 30;
  const pad = 3;
  if (values.length < 2) {
    return <svg className={s.spark} width={w} height={h} role="img" aria-label={`${label}: no trend yet`} />;
  }
  const max = Math.max(...values, 1);
  const x = (i: number): number => pad + (i / (values.length - 1)) * (w - 2 * pad);
  const y = (v: number): number => h - pad - (v / max) * (h - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg
      className={s.spark}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: trend over ${values.length} runs, latest ${int(values[values.length - 1])}`}
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(values.length - 1).toFixed(1)} cy={y(values[values.length - 1]!).toFixed(1)} r="2.2" fill="currentColor" />
    </svg>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={s.statCard}>
      <div className={s.statLabel}>{label}</div>
      <div className={`${s.statValue} ${warn ? s.warnNum : ''}`}>{value}</div>
      {sub ? <div className={s.statSub}>{sub}</div> : null}
    </div>
  );
}

function Trend({ label, values, fmt }: { label: string; values: number[]; fmt: (n: number) => string }) {
  return (
    <div className={s.trendItem}>
      <div className={s.trendHead}>
        <span className={s.statLabel}>{label}</span>
        <span className={s.trendNow}>{fmt(values[values.length - 1] ?? 0)}</span>
      </div>
      <Sparkline values={values} label={label} />
    </div>
  );
}

export interface OperationsViewProps {
  rows: PipelineRunRow[];
  total: number;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}

/** Presentational console — split from data so it can be unit-tested + previewed with mocks. */
export function OperationsView({ rows, total, loading, error, onReload }: OperationsViewProps) {
  const agg = useMemo(() => aggregateLlm(rows), [rows]);
  const chrono = useMemo(() => [...rows].reverse(), [rows]); // charts read oldest → newest
  const totals = useMemo(
    () => ({
      requests: agg.reduce((n, u) => n + u.requests, 0),
      tokens: agg.reduce((n, u) => n + u.tokens, 0),
      rateLimited: agg.reduce((n, u) => n + u.rateLimited, 0),
      overloaded: agg.reduce((n, u) => n + u.overloaded, 0),
    }),
    [agg],
  );

  const latest = rows[0];
  const latestGeminiOk = (latest?.detail?.llm ?? [])
    .filter((u) => u.provider === 'gemini')
    .reduce((n, u) => n + u.ok, 0);
  const down = latest?.gemini_down ?? false;
  const lastRel = latest ? relTime(latest.run_at) : '';

  return (
    <section aria-label="Operations">
      <div className={s.toolbar}>
        <span className={s.count}>Pulse Pipeline — LLM usage, limits &amp; run health</span>
        <span className={s.toolSpacer} />
        {!loading && latest && (
          <span className={s.count}>
            {int(total)} runs{lastRel ? ` · updated ${lastRel}` : ''}
          </span>
        )}
        <button type="button" className={s.btn} onClick={onReload} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading && rows.length === 0 ? (
        <Loading label="Loading run history…" />
      ) : rows.length === 0 ? (
        <Empty>
          No pipeline runs recorded yet. The console populates after the next pipeline run — make sure
          the owner has re-run <code>supabase/schema.sql</code> so the <code>pipeline_runs</code> table
          exists.
        </Empty>
      ) : (
        <>
          <div className={`${s.opsBanner} ${down ? s.opsBannerBad : s.opsBannerOk}`} role="status">
            <span className={`${s.opsDot} ${down ? s.opsDotBad : s.opsDotOk}`} aria-hidden />
            <div>
              <strong>
                {down
                  ? 'Gemini unavailable — briefings fell back to Groq'
                  : `Gemini healthy — ${int(latestGeminiOk)} briefing${latestGeminiOk === 1 ? '' : 's'} last run`}
              </strong>
              <div className={s.opsBannerSub}>
                Last run {clockTime(latest!.run_at)}
                {lastRel ? ` (${lastRel})` : ''} · {duration(latest!.duration_ms)}
                {latest!.run_id ? (
                  <>
                    {' · '}
                    <a
                      href={`https://github.com/squireaintready/crowdtells/actions/runs/${latest!.run_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className={s.opsLink}
                    >
                      run log ↗
                    </a>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className={s.opsGrid}>
            <Stat label="Generated" value={int(latest!.generated)} sub="last run" />
            <Stat label="Skipped" value={int(latest!.skipped)} sub="last run" />
            <Stat label="Results" value={int(latest!.results)} sub="last run" />
            <Stat label="Briefed" value={int(latest!.briefed)} sub="total live" />
            <Stat label="Duration" value={duration(latest!.duration_ms)} sub="last run" />
            <Stat label="Tokens" value={tokens(totals.tokens)} sub={`${rows.length} runs`} />
            <Stat label="LLM calls" value={int(totals.requests)} sub={`${rows.length} runs`} />
            <Stat
              label="Limit hits"
              value={int(totals.rateLimited + totals.overloaded)}
              sub={`429+503, ${rows.length} runs`}
              warn={totals.rateLimited + totals.overloaded > 0}
            />
          </div>

          <div className={s.trends}>
            <Trend label="Tokens / run" values={chrono.map(sumTokens)} fmt={tokens} />
            <Trend label="LLM calls / run" values={chrono.map(sumReq)} fmt={int} />
            <Trend label="Briefings / run" values={chrono.map((r) => r.generated ?? 0)} fmt={int} />
          </div>

          <h3 className={s.opsH3}>LLM usage by model · last {rows.length} runs</h3>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Provider · model</th>
                  <th className={s.num}>Calls</th>
                  <th className={`${s.num} ${s.hideSm}`}>OK</th>
                  <th className={s.num}>429</th>
                  <th className={`${s.num} ${s.hideSm}`}>503</th>
                  <th className={`${s.num} ${s.hideSm}`}>Fail</th>
                  <th className={s.num}>Tokens</th>
                  <th className={`${s.num} ${s.hideSm}`}>Avg ms</th>
                </tr>
              </thead>
              <tbody>
                {agg.map((u) => (
                  <tr key={`${u.provider}:${u.model}`}>
                    <td data-label="Model">
                      <span className={`${s.pill} ${u.provider === 'gemini' ? s.provGem : s.provGroq}`}>
                        {u.provider}
                      </span>{' '}
                      <span className={s.mono}>{u.model}</span>
                    </td>
                    <td className={s.num} data-label="Calls">
                      {int(u.requests)}
                    </td>
                    <td className={`${s.num} ${s.hideSm}`} data-label="OK">
                      {int(u.ok)}
                    </td>
                    <td className={s.num} data-label="429">
                      {u.rateLimited > 0 ? <strong className={s.warnNum}>{int(u.rateLimited)}</strong> : '0'}
                    </td>
                    <td className={`${s.num} ${s.hideSm}`} data-label="503">
                      {u.overloaded > 0 ? <strong className={s.warnNum}>{int(u.overloaded)}</strong> : '0'}
                    </td>
                    <td className={`${s.num} ${s.hideSm}`} data-label="Fail">
                      {int(u.failed)}
                    </td>
                    <td className={s.num} data-label="Tokens">
                      {tokens(u.tokens)}
                    </td>
                    <td className={`${s.num} ${s.hideSm}`} data-label="Avg ms">
                      {u.requests ? Math.round(u.latencyMsTotal / u.requests) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {latest!.detail?.sourceErrors && latest!.detail.sourceErrors.length > 0 && (
            <>
              <h3 className={s.opsH3}>Source-fetch errors · last run</h3>
              <div className={s.opsChips}>
                {latest!.detail.sourceErrors.slice(0, 12).map((e) => (
                  <span key={e.source} className={s.opsErrChip}>
                    {e.source} <span className={s.warnNum}>×{e.count}</span>
                  </span>
                ))}
              </div>
            </>
          )}

          <h3 className={s.opsH3}>Run log</h3>
          <div className={s.terminal} role="log" aria-label="Recent pipeline runs">
            {rows.map((r) => {
              const gemOk = (r.detail?.llm ?? [])
                .filter((u) => u.provider === 'gemini')
                .reduce((n, u) => n + u.ok, 0);
              return (
                <div key={r.id} className={s.termLine}>
                  <span className={s.termTime}>{clockTime(r.run_at)}</span>
                  <span className={s.termSeg}>{duration(r.duration_ms)}</span>
                  <span className={s.termSeg}>
                    gen <b>{int(r.generated)}</b> · skip {int(r.skipped)}
                    {r.results ? <> · res {int(r.results)}</> : null}
                  </span>
                  <span className={`${s.termBadge} ${r.gemini_down ? s.termBadgeBad : s.termBadgeOk}`}>
                    {r.gemini_down ? 'Gemini DOWN → Groq' : `Gemini ${int(gemOk)}`}
                  </span>
                  {r.commit_sha ? <span className={s.termCommit}>{r.commit_sha}</span> : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** Data wrapper: pulls recent runs via the admin RPC and hands them to the view. */
export function OperationsTab() {
  const q = useAdminQuery(() => listPipelineRuns({ limit: LOAD }), 'ops');
  return (
    <OperationsView
      rows={q.data?.rows ?? []}
      total={q.data?.total ?? 0}
      loading={q.loading}
      error={q.error}
      onReload={q.reload}
    />
  );
}
