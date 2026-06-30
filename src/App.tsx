import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Feed, Market } from './lib/types';
import type { EngagementStat } from './lib/engagement';
import { categoriesOf, dedupeByEvent, loadFeed, sectionBackLabel, selectStories, type Section } from './lib/feed';
import { headMeta, searchToState, stateToSearch, type Overlay, type UrlState } from './lib/urlState';
import { storyPath, storySlug } from './lib/storyPath';
import { topicPath } from './lib/topicPath';
import { hydrateBriefing } from './lib/hydrate';
import { useInterests } from './hooks/useInterests';
import { useAuthBreadcrumb } from './lib/authBreadcrumb';
import { useEngagementGate } from './hooks/useEngagementGate';
import { useSavedIds } from './lib/saved';
import { Header } from './components/Header';
import { Controls } from './components/Controls';
import { Onboarding } from './components/Onboarding';
import { CatchUp } from './components/CatchUp';
import { Scoreboard } from './components/Scoreboard';
import { StoryCard } from './components/StoryCard';
import { CrowdWall } from './components/CrowdWall';
import { LoadMore } from './components/LoadMore';
import { ArticleView } from './components/ArticleView';
import { DevelopingWidget } from './components/Breaking';
import { EmptyState, ErrorState, LoadingState } from './components/States';
import { NewsletterSignup } from './components/NewsletterSignup';
import { WelcomeBanner } from './components/WelcomeBanner';
import { NewsletterPrompt } from './components/NewsletterPrompt';
import { newsletterEnabled, realtimeFeedEnabled } from './lib/social';
import { confirmSubscription, unsubscribeByToken, unsubscribeRepliesByToken } from './lib/newsletter';
import { setKnownCategories } from './lib/categories';
import { registerContext, track } from './lib/posthog';
import styles from './App.module.css';

// The admin console is a lazily-loaded takeover (its own chunk, pulling in supabase-js
// only when opened), so it never weighs down the feed bundle. Mounted only on ?admin.
const AdminPanel = lazy(() => import('./components/admin/AdminPanel'));

const REFRESH_MS = 5 * 60 * 1000;
// The feed renders a growing window rather than the whole list at once: only the
// first PAGE stories mount, then "Load more" (auto-loading as it nears the
// viewport) reveals another PAGE at a time. Keeps first paint, the DOM, and the
// per-card observers/listeners cheap on a long feed, with no cost to short ones.
// This is purely the client window — it has no SEO bearing: the static homepage
// is prerendered separately (scripts/lib/prerender.ts shows the top stories with
// links to each indexable /s/ page), and React replaces that markup on mount.
const PAGE = 12;
// How often we re-pull live engagement velocity (distinct-user likes/comments) so
// Top reflects what readers are reacting to between pipeline runs. Cheap: one bulk
// RPC over the visible ids.
const ENGAGEMENT_REFRESH_MS = 3 * 60 * 1000;
const ENGAGEMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Clip to a tidy meta-description length on a word boundary. */
function clipMeta(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** The meta description for an opened story — its standfirst, else the briefing's
 * lead (with {tokens} hydrated to live numbers), clipped. Mirrors the static /s/
 * page so the SPA-rendered DOM matches its indexable twin. */
function storyDescription(m: Market): string {
  return clipMeta(m.dek || hydrateBriefing(m.analysis ?? '', m) || m.hook || m.title);
}

type Status = 'loading' | 'ready' | 'error';

// The newsletter slide-in is FREQUENCY-CAPPED, not once-forever (industry practice for
// a non-blocking email capture): it waits for engagement, auto-retracts if ignored, and
// returns on a LATER visit after a cooldown — explicit dismissal rests longer, and after
// a few un-converted shows it stops entirely, so it nudges without nagging. Subscribing
// ends it for good. State persists in localStorage (guarded for private-mode/SSR).
const NL_PROMPT_KEY = 'ct:nlPrompt';
const NL_DAY_MS = 86_400_000;
const NL_SNOOZE_IGNORED = 3 * NL_DAY_MS; // auto-dismissed (just ignored) → back in a few days
const NL_SNOOZE_DISMISSED = 30 * NL_DAY_MS; // explicitly closed → a much longer rest
const NL_MAX_SHOWS = 4; // after this many un-converted shows, stop nudging for good

interface NlState {
  status: 'subscribed' | 'snoozed';
  /** Epoch ms before which the prompt stays suppressed (Infinity = forever). */
  until: number;
  /** How many times we've shown-and-not-converted (drives the give-up cap). */
  shows: number;
}

function readNlState(): NlState | null {
  try {
    const raw = window.localStorage.getItem(NL_PROMPT_KEY);
    if (!raw) return null;
    // Legacy (pre-frequency-cap) values were the bare strings 'subscribed'/'dismissed',
    // both meaning "never again" — honor that so we don't suddenly re-nag old visitors.
    if (raw === 'subscribed') return { status: 'subscribed', until: Infinity, shows: NL_MAX_SHOWS };
    if (raw === 'dismissed') return { status: 'snoozed', until: Infinity, shows: NL_MAX_SHOWS };
    const s = JSON.parse(raw) as NlState;
    return s && (s.status === 'subscribed' || s.status === 'snoozed') ? s : null;
  } catch {
    return null;
  }
}
/** Is the prompt suppressed right now — subscribed, or still inside a snooze window? */
function nlPromptBlocked(now = Date.now()): boolean {
  const s = readNlState();
  return !!s && (s.status === 'subscribed' || now < s.until);
}
function writeNlState(s: NlState): void {
  try {
    window.localStorage.setItem(NL_PROMPT_KEY, JSON.stringify(s));
  } catch {
    /* private mode / storage disabled — fall back to in-memory state only */
  }
}
function markNlSubscribed(): void {
  writeNlState({ status: 'subscribed', until: Infinity, shows: NL_MAX_SHOWS });
}
/** Snooze + count the show. Once we've nudged NL_MAX_SHOWS times without a subscribe,
 *  rest for a year (effectively stop) so we never nag a clearly-uninterested reader. */
function markNlSnoozed(reason: 'ignored' | 'dismissed', now = Date.now()): void {
  const shows = (readNlState()?.shows ?? 0) + 1;
  const cooldown = reason === 'dismissed' ? NL_SNOOZE_DISMISSED : NL_SNOOZE_IGNORED;
  const until = shows >= NL_MAX_SHOWS ? now + 365 * NL_DAY_MS : now + cooldown;
  writeNlState({ status: 'snoozed', until, shows });
}

export function App() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  const [section, setSection] = useState<Section>('top');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The admin console takeover (?admin), read straight from the URL on mount so it
  // opens without waiting for the feed. Guarded for SSR/private-mode like nlPromptSeen.
  const [admin, setAdmin] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).has('admin');
    } catch {
      return false;
    }
  });
  // A back-dismissible modal sheet (account sign-in / personalize picker), mirrored
  // into the URL (?o=) so the browser/OS Back gesture closes it instead of leaving the
  // site. ALWAYS starts null — a shared ?o= link is NOT a landing modal (the strip
  // effect below removes it on first mount); the overlay only ever exists as an
  // in-session history entry pushed when the reader opens a sheet.
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  // How many stories of the active list are currently rendered (the feed window).
  const [limit, setLimit] = useState(PAGE);
  // Polite live-region text announcing each freshly-revealed batch to assistive
  // tech; cleared whenever the list context changes (see the reset effect below).
  const [announce, setAnnounce] = useState('');
  const [nlPromptDone, setNlPromptDone] = useState(nlPromptBlocked);
  // The footer newsletter card and the floating prompt ask the same thing — so when the
  // reader scrolls the explicit card into view, retract the floating one (no double-ask).
  const [footerNlInView, setFooterNlInView] = useState(false);
  const footerNlRef = useRef<HTMLDivElement>(null);
  const interests = useInterests();
  // Live engagement velocity per story (distinct-user likes/comments in the last
  // day), blended into the Top order. Starts empty and stays inert until the bulk
  // RPC returns data, so the feed is never blocked on it.
  const [engagement, setEngagement] = useState<Map<string, EngagementStat>>(() => new Map());

  // Set once the live Realtime snapshot has taken over, so the static feed.json
  // fetch (first paint, or a late resolve) can't clobber live data.
  const hasLiveData = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await loadFeed(signal);
      if (!hasLiveData.current) setFeed(data);
      setStatus('ready');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setStatus((s) => (s === 'ready' ? s : 'error'));
    }
  }, []);

  useEffect(() => {
    // The admin takeover doesn't need the feed — skip the fetch + poll entirely while
    // it's open; exiting admin re-runs this effect and loads the feed then.
    if (admin) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    // With the live Realtime feed on (Model B), deltas keep the feed fresh — skip
    // the 5-min poll so it can't clobber live state with a staler feed.json.
    const id = realtimeFeedEnabled ? null : setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      controller.abort();
      if (id) clearInterval(id);
    };
  }, [refresh, admin]);

  // Model B: layer live Supabase Realtime updates over the static first-paint
  // feed (a snapshot reconciles on connect/reconnect, then per-market deltas
  // stream in). supabase-js stays lazy; inert unless VITE_REALTIME_FEED=true.
  useEffect(() => {
    if (!realtimeFeedEnabled || admin) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void import('./lib/realtimeFeed').then(({ subscribeFeed }) =>
      subscribeFeed(
        (updater) => setFeed((f) => updater(f)),
        () => {
          hasLiveData.current = true;
          setStatus('ready'); // live data can stand alone if the static fetch failed
        },
      ).then((unsub) => {
        if (cancelled) unsub();
        else cleanup = unsub;
      }),
    );
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [admin]);

  // Consume a newsletter email link (?confirm=<token> double opt-in, or
  // ?unsubscribe=<token> one-click opt-out) on first mount, independent of the
  // feed: it must work even before the feed loads. (newsletter.ts is already eager
  // via the signup components and keeps supabase-js lazy through its own internal
  // import, so this is a plain static import.) Surface a dismissible result banner,
  // then strip the param without clobbering other params (?s= etc.) or adding a
  // history entry.
  const confirmHandled = useRef(false);
  const [confirmResult, setConfirmResult] = useState<string | null>(null);
  useEffect(() => {
    if (confirmHandled.current) return;
    confirmHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const confirmToken = params.get('confirm');
    const unsubToken = params.get('unsubscribe');
    const replyUnsubToken = params.get('reply_unsubscribe');
    if (!confirmToken && !unsubToken && !replyUnsubToken) return;
    void (async () => {
      if (confirmToken) {
        const ok = await confirmSubscription(confirmToken);
        setConfirmResult(
          ok
            ? 'Your subscription is confirmed — welcome to Crowdtells.'
            : 'That confirmation link is invalid or expired.',
        );
      } else if (unsubToken) {
        const ok = await unsubscribeByToken(unsubToken);
        setConfirmResult(
          ok
            ? "You've been unsubscribed — the brief won't land in your inbox anymore."
            : 'That unsubscribe link is invalid or expired.',
        );
      } else if (replyUnsubToken) {
        const ok = await unsubscribeRepliesByToken(replyUnsubToken);
        setConfirmResult(
          ok
            ? "Reply notifications are off — we won't email you about replies anymore."
            : 'That link is invalid or expired.',
        );
      }
    })();
    params.delete('confirm');
    params.delete('unsubscribe');
    params.delete('reply_unsubscribe');
    const next = params.toString();
    const href = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', href);
  }, []);

  // Overlay sheets (?o=) are in-session-only: a shared/bookmarked ?o= link must NOT
  // auto-open the modal on a cold load (you'd land in a sheet you can't Back out of
  // to a real page). Strip the param on first mount — mirrors the ?s= deep-link strip
  // — so `overlay` stays null on load and the sheet only ever appears as a history
  // entry the reader pushed in-session. Runs before the URL-sync effect engages.
  const overlayStripped = useRef(false);
  useEffect(() => {
    if (overlayStripped.current) return;
    overlayStripped.current = true;
    try {
      const sp = new URLSearchParams(window.location.search);
      if (!sp.has('o')) return;
      sp.delete('o');
      const q = sp.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash}`,
      );
    } catch {
      /* history/URL unavailable — best effort; overlay state already defaults null */
    }
  }, []);

  // A signed-out admin who started sign-in from the /?admin gate bounces back to the
  // homepage (the OAuth/magic-link redirect carries no ?admin) — restore the takeover
  // from the one-shot breadcrumb the gate left, so they land back in the console.
  useEffect(() => {
    try {
      const onAdminUrl = new URLSearchParams(window.location.search).has('admin');
      if (sessionStorage.getItem('ct:returnAdmin')) {
        sessionStorage.removeItem('ct:returnAdmin');
        if (!onAdminUrl) setAdmin(true);
      }
    } catch {
      /* private mode — no-op */
    }
  }, []);

  // Where the feed was scrolled when a story was opened, so closing it returns
  // the reader to their place instead of the top.
  const feedScroll = useRef(0);

  // Consume the landing URL once the feed has loaded: restore section/query/
  // category (?sec=/?q=/?c=) and, for a shared story (?s=<marketId>), open its
  // article, suppress onboarding for the visit, and — if the story has aged out of
  // the rolling feed — fall back to its permanent static /s/ briefing.
  const deepLinked = useRef(false);
  const [cameFromShare, setCameFromShare] = useState(false);
  useEffect(() => {
    if (deepLinked.current || !feed) return;
    deepLinked.current = true;
    const parsed = searchToState(window.location.search, {
      categoryExists: (c) => feed.markets.some((m) => m.category === c),
    });
    if (parsed.section !== 'top') setSection(parsed.section);
    if (parsed.query) setQuery(parsed.query);
    if (parsed.category) setCategory(parsed.category);
    const id = parsed.expandedId;
    if (!id) return;
    const target = feed.markets.find((m) => m.id === id);
    if (!target) {
      // The story has aged out of the live feed, but its permanent static /s/
      // briefing still exists (append-only store) — send the reader to that real
      // content instead of a dead-link state. A tapped share arrived here via the
      // /s/ page's #app bounce; redirecting back to /s/ (no #app) shows the
      // briefing and won't bounce again (a static page → no loop).
      window.location.replace(storyPath(id));
      return;
    }
    // A deep link — a shared article URL, or the /s/#app bounce — makes the article the
    // only in-site history entry, so the browser Back button would leave Crowdtells
    // entirely (back to wherever the reader came from) instead of going to the feed.
    // Synthesize the feed "home" behind it: rewrite the current entry to the same URL
    // minus ?s=, so the expand below pushes the article ON TOP. Back now lands on the
    // feed. (In-site opens already push their own entry, so this only affects the
    // landing case; the deep-link effect runs once, guarded by deepLinked.)
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.has('s')) {
        sp.delete('s');
        const q = sp.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
      }
    } catch {
      /* history/URL unavailable — best effort; falls back to prior behaviour */
    }
    setCameFromShare(true);
    if (target.status === 'resolved') setSection('past');
    setExpandedId(target.id);
  }, [feed]);

  const markets = useMemo(() => feed?.markets ?? [], [feed]);

  // Pull live engagement velocity for the active feed (one bulk RPC), refreshed on a
  // gentle interval, and re-key only when the set of active stories actually changes
  // so realtime odds deltas don't thrash it. Fully fail-soft + lazy: supabase-js is
  // imported on demand and any error just leaves the baked ranking in place.
  const activeIdsKey = useMemo(
    () =>
      markets
        .filter((m) => m.status === 'active')
        .map((m) => m.id)
        .sort()
        .join(','),
    [markets],
  );
  useEffect(() => {
    const ids = activeIdsKey ? activeIdsKey.split(',') : [];
    if (ids.length === 0 || admin) return;
    let cancelled = false;
    const load = async () => {
      const { fetchEngagement } = await import('./lib/engagement');
      const map = await fetchEngagement(ids, Date.now() - ENGAGEMENT_WINDOW_MS);
      if (!cancelled && map.size > 0) setEngagement(map);
    };
    void load();
    const id = setInterval(() => void load(), ENGAGEMENT_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeIdsKey, admin]);

  // The story currently opened as a full-page article (null = the feed). Cache the
  // last-known Market so an open article survives its market leaving the live feed
  // mid-session (Realtime DELETE / churn) — it stays open just like on the static path.
  const lastOpenRef = useRef<Market | null>(null);
  // A digest (sports line / recurring prop) is never briefed and has no in-app article;
  // opening one (via a Related/CatchUp/Developing link or a shared ?s= URL) sends the
  // reader to the platform instead of a content-less ArticleView. Guarded so a markets
  // refresh that re-resolves the same digest doesn't pop a second tab.
  const digestOpenedRef = useRef<string | null>(null);
  const activeMarket = useMemo(() => {
    if (!expandedId) {
      lastOpenRef.current = null;
      digestOpenedRef.current = null;
      return null;
    }
    const live = markets.find((m) => m.id === expandedId);
    const resolved = live ?? lastOpenRef.current;
    if (resolved?.format === 'digest') {
      if (digestOpenedRef.current !== resolved.id) {
        digestOpenedRef.current = resolved.id;
        window.open(resolved.marketUrl, '_blank', 'noopener,noreferrer');
      }
      return null;
    }
    if (live) lastOpenRef.current = live;
    return resolved;
  }, [expandedId, markets]);

  // In-session navigation (e.g. a "Related on the board" link) to a story whose market
  // has since aged out of the live feed would otherwise leave ?s=<id> in the URL while
  // the PREVIOUS article stays mounted (the lastOpenRef fallback above) — a silent
  // wrong-article. Send the reader to that story's permanent /s/ page instead, mirroring
  // the cold-load deep-link fallback. Skips the current article aging out mid-read (it
  // stays open: lastOpenRef === the requested id), and the landing case (the deep-link
  // effect owns that until deepLinked.current is set).
  useEffect(() => {
    if (!deepLinked.current || !expandedId || !feed) return;
    if (markets.some((m) => m.id === expandedId)) return; // present in the live feed → fine
    if (lastOpenRef.current?.id === expandedId) return; // the open article aged out mid-read → keep it
    window.location.replace(storyPath(expandedId));
  }, [expandedId, markets, feed]);

  // Keep the <head> in sync with the SPA view so shared ?s=/?c=/?q= links aren't
  // crawled as duplicates of the homepage AND a JS-rendering crawler (Googlebot)
  // sees the same title/description/social card as the static /s/ twin: an open
  // story canonicals to its static /s/ twin (og:type article, its own card), a
  // category to its /topic hub, search results go noindex. (The SPA otherwise only
  // ever shows index.html's homepage head.)
  useEffect(() => {
    // The admin takeover has its own title; don't paint the homepage head over it.
    if (admin) {
      document.title = 'Admin · Crowdtells';
      return;
    }
    const meta = headMeta(
      { query, category, expandedId },
      {
        origin: window.location.origin,
        story: activeMarket
          ? {
              path: storyPath(activeMarket.id),
              title: activeMarket.hook || activeMarket.title,
              description: storyDescription(activeMarket),
              image: `${window.location.origin}/og/${storySlug(activeMarket.id)}.png`,
            }
          : null,
        topicPath: category ? topicPath(category) : null,
      },
    );
    document.title = meta.title;
    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    canonical.href = meta.canonical;
    // Find-or-create a meta tag and set its content, so Back→home restores the
    // shell's own values rather than leaving a previously-opened story's behind.
    const setMeta = (attr: 'name' | 'property', key: string, content: string) => {
      let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };
    setMeta('name', 'robots', meta.robots);
    setMeta('name', 'description', meta.description);
    setMeta('property', 'og:type', meta.ogType);
    setMeta('property', 'og:title', meta.title);
    setMeta('property', 'og:description', meta.description);
    setMeta('property', 'og:url', meta.canonical);
    setMeta('property', 'og:image', meta.image);
    setMeta('name', 'twitter:title', meta.title);
    setMeta('name', 'twitter:description', meta.description);
    setMeta('name', 'twitter:image', meta.image);
  }, [query, category, expandedId, activeMarket, admin]);

  // Single source of truth for the URL: reflect the view state into the
  // querystring (shareable/bookmarkable, clean home URL) and restore it on
  // Back/Forward. Section/category changes and opening a story push a new history
  // entry (so Back closes the article / returns to the prior section); query
  // edits replace the current one. The deep-link effect above owns the initial
  // URL, so this skips its first (mount) run.
  const marketsRef = useRef(markets);
  marketsRef.current = markets;
  const fromPopstate = useRef(false);
  const syncInit = useRef(true);
  const lastNav = useRef<{
    section: Section;
    category: string | null;
    expandedId: string | null;
    admin: boolean;
    overlay: Overlay | null;
  }>({
    section,
    category,
    expandedId,
    admin,
    overlay,
  });
  useEffect(() => {
    if (syncInit.current) {
      syncInit.current = false;
      lastNav.current = { section, category, expandedId, admin, overlay };
      return;
    }
    const prevNav = lastNav.current;
    lastNav.current = { section, category, expandedId, admin, overlay };
    if (fromPopstate.current) {
      fromPopstate.current = false; // Back/Forward already moved the history pointer
      return;
    }
    const next = stateToSearch({ section, query, category, expandedId, admin, overlay });
    if (next === window.location.search.replace(/^\?/, '')) return; // loop guard
    const href = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
    const opened = !prevNav.expandedId && expandedId; // null → story = a navigation
    const adminToggled = prevNav.admin !== admin; // entering/leaving admin is a navigation
    // Opening a sheet (null → overlay) is a navigation that PUSHES its own entry, so
    // Back closes it. Closing it (overlay → null) is NOT a push trigger — closeOverlay
    // pops that entry via history.back (back-symmetric), and any straight state-clear
    // here just REPLACES, so we never strand a forward entry.
    const overlayOpened = !prevNav.overlay && overlay;
    if (
      prevNav.section !== section ||
      prevNav.category !== category ||
      opened ||
      adminToggled ||
      overlayOpened
    ) {
      window.history.pushState(null, '', href);
    } else {
      window.history.replaceState(null, '', href);
    }
  }, [section, query, category, expandedId, admin, overlay]);

  useEffect(() => {
    const onPop = () => {
      fromPopstate.current = true;
      // Only validate ?c= against the feed once it has loaded; if Back fires
      // before the feed arrives, accept the category as-is rather than dropping
      // a legitimate filter (selectStories handles a since-vanished category).
      const loaded = marketsRef.current.length > 0;
      const s: UrlState = searchToState(window.location.search, {
        categoryExists: loaded
          ? (c) => marketsRef.current.some((m) => m.category === c)
          : undefined,
      });
      setSection(s.section);
      setQuery(s.query);
      setCategory(s.category);
      setExpandedId(s.expandedId);
      setAdmin(s.admin);
      setOverlay(s.overlay);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Own scroll restoration so the browser's automatic per-entry restore can't
  // race/override our manual feed-position restore on Back. Without this the
  // swipe-open path (whose history entry is pushed mid-gesture) lands at the top,
  // while the tap path happens to agree with the browser's guess.
  useEffect(() => {
    if (!('scrollRestoration' in window.history)) return;
    const prev = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = prev;
    };
  }, []);

  // Opening an article jumps to the top; closing restores the feed position.
  useEffect(() => {
    if (status !== 'ready') return;
    if (expandedId) window.scrollTo(0, 0);
    else window.scrollTo(0, feedScroll.current);
  }, [expandedId, status]);

  const sectionStatus = section === 'past' ? 'resolved' : 'active';
  const categories = useMemo(
    // ≥2 markets: thin one-off tags (incl. any not-yet-canonicalized source tag)
    // stay out of the filter rail, mirroring the /topic hub threshold.
    () => categoriesOf(
      markets.filter((m) => m.status === sectionStatus),
      2,
    ),
    [markets, sectionStatus],
  );
  const savedIds = useSavedIds();
  const visible = useMemo(() => {
    if (section === 'saved') {
      const order = new Map(savedIds.map((id, i) => [id, i]));
      return markets
        .filter((m) => order.has(m.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    return selectStories(markets, {
      section,
      query,
      category,
      topics: interests.topics,
      engagement,
    });
  }, [markets, section, query, category, interests.topics, savedIds, engagement]);
  // The rendered slice of the active list (the feed window). Memoized so the slice
  // only re-allocates when the list or the window actually changes — not on the
  // many unrelated re-renders (opening a story, engagement ticks, prompts).
  const visiblePage = useMemo(() => visible.slice(0, limit), [visible, limit]);
  // Search analytics, debounced to fire once the reader pauses — with the live result
  // count. The raw query IS captured: for a news search that's product signal (what
  // readers want that we might not cover), not the sensitive free-text we exclude
  // elsewhere (comments, email). visible is read via a ref so a later realtime re-rank
  // doesn't refire the event.
  const visibleCountRef = useRef(0);
  visibleCountRef.current = visible.length;
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const t = window.setTimeout(() => {
      track('search_performed', {
        query: q,
        query_length: q.length,
        has_results: visibleCountRef.current > 0,
        result_count: visibleCountRef.current,
      });
    }, 700);
    return () => window.clearTimeout(t);
  }, [query]);
  // Collapse the feed window back to the first page whenever the reader changes
  // what they're looking at (section, search, topic filter, or followed
  // interests) — a fresh list starts from the top. Deliberately NOT keyed on
  // live data (markets/engagement) or opening a story, so realtime updates and
  // returning from an article keep the reader's place and loaded window intact.
  const topicsKey = useMemo(() => interests.topics.join(','), [interests.topics]);
  useEffect(() => {
    setLimit(PAGE);
    // Drop any prior batch announcement so AT never re-reads a stale count for the
    // previous list: a reset SHRINKS the window, so the grow-only effect below
    // won't speak for the new one and would otherwise leave the old text behind.
    setAnnounce('');
  }, [section, query, category, topicsKey]);
  // Announce each freshly-revealed batch to assistive tech (the polite live region
  // below), so a screen-reader reader knows the auto-loaded/clicked stories
  // arrived. Fires only when the window GROWS — never on a reset or a realtime
  // re-rank — so it speaks exactly when the reader pulled in more.
  const prevLimit = useRef(limit);
  useEffect(() => {
    if (limit > prevLimit.current) {
      setAnnounce(`Showing ${Math.min(limit, visible.length)} of ${visible.length} stories.`);
    }
    prevLimit.current = limit;
  }, [limit, visible.length]);
  const allTopics = useMemo(
    // ≥2 markets: don't offer a one-off tag as a followable topic (see categoriesOf).
    () => categoriesOf(markets.filter((m) => m.status === 'active'), 2),
    [markets],
  );
  // Publish the live category universe so the lazy account menu's newsletter
  // topic picker can read it without prop-drilling through the header.
  useEffect(() => {
    setKnownCategories(allTopics);
  }, [allTopics]);
  const catchUp = useMemo(
    () =>
      dedupeByEvent(
        // Exclude digests — CatchUp opens an in-app article, which a digest doesn't have.
        [...markets]
          .filter((m) => m.status === 'active' && m.format !== 'digest')
          .sort((a, b) => b.score - a.score),
        6,
      ),
    [markets],
  );
  // The personalize nudge is shown to SIGNED-IN readers only — anonymous visitors get
  // a clean landing, and following topics is most meaningful once it syncs to an account.
  const signedIn = useAuthBreadcrumb() !== null;
  const firstRun =
    status === 'ready' && !interests.onboarded && allTopics.length > 0 && !cameFromShare;
  // Register the global context PostHog attaches to EVERY event (incl. autocapture):
  // theme + reading intensity (from the pre-paint <html> data-*), signed-in, returning.
  useEffect(() => {
    registerContext({ signedIn });
  }, [signedIn]);
  // First-run personalization is now a quiet, dismissible WelcomeBanner — not a
  // blocking modal. The full picker opens only on an explicit action (the banner's
  // "Choose topics" or the Personalize button), both of which set the 'personalize'
  // overlay — a back-dismissible URL-backed sheet (?o=personalize), like the account
  // sheet. (Its triggers only render off-article, so it never shows over a story.)
  const showPicker = overlay === 'personalize' && !activeMarket;
  // The topic picker opened (first-run welcome, or an explicit edit).
  useEffect(() => {
    if (showPicker) track('onboarding_opened', { mode: firstRun ? 'welcome' : 'edit' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPicker]);
  // Newsletter slide-in: armed once a reader engages with an article (scroll past the
  // fold OR a quiet dwell). Non-blocking, frequency-capped (see nlPromptBlocked).
  const nlEngaged = useEngagementGate(!!activeMarket && newsletterEnabled && !nlPromptDone);

  // Track when the explicit footer signup card is on screen, so the floating prompt can
  // retract (no double-ask) and return when the reader scrolls back up. Only wired while
  // the prompt is live; IntersectionObserver is supported in every target browser.
  useEffect(() => {
    const el = footerNlRef.current;
    if (!el || nlPromptDone || !newsletterEnabled || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setFooterNlInView(!!entry?.isIntersecting),
      { rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
    // newsletterEnabled is a module constant (not reactive), so it's intentionally not a dep.
  }, [nlPromptDone, activeMarket]);

  const onSection = (next: Section) => {
    track('section_changed', { section: next });
    setSection(next);
    setCategory(null);
    setExpandedId(null);
  };
  // Explicit user category-filter clicks (not the programmatic clears in onSection or
  // the deep-link path), and opening the topic picker — both are discovery signals.
  const onCategory = useCallback((cat: string | null) => {
    track('category_filtered', { category: cat ?? 'all' });
    setCategory(cat);
  }, []);
  const openInterests = useCallback((source: string) => {
    track('personalize_opened', { source });
    setOverlay('personalize');
  }, []);
  // Close the current overlay sheet (account / personalize) IDENTICALLY to a Back
  // gesture, with no stranded/duplicate history entries. The overlay always owns the
  // TOP history entry when open (opening pushed ?o=), so popping it is the clean move:
  // history.back() fires popstate → onPop clears `overlay` from the URL, and the
  // fromPopstate echo guard suppresses a re-write. Reading the live URL is the
  // authoritative "is the overlay entry on the stack?" check. The else branch is purely
  // defensive (no ?o= entry, e.g. stripped) — clearing state then REPLACES (overlay→null
  // isn't a push trigger), so it still never strands a forward entry.
  const closeOverlay = useCallback(() => {
    let onOverlayEntry = false;
    try {
      onOverlayEntry = new URLSearchParams(window.location.search).has('o');
    } catch {
      /* URL unavailable — fall through to the direct state clear */
    }
    if (onOverlayEntry) window.history.back();
    else setOverlay(null);
  }, []);
  // Open a story's article from the feed, remembering the scroll position.
  const openArticle = useCallback((id: string) => {
    feedScroll.current = window.scrollY;
    setExpandedId(id);
  }, []);
  const onBack = useCallback(() => setExpandedId(null), []);
  // CatchUp can surface a story from any section, so it clears the filters first.
  const openStory = useCallback((id: string) => {
    feedScroll.current = window.scrollY;
    setSection('top');
    setCategory(null);
    setQuery('');
    setExpandedId(id);
  }, []);

  // The admin console is a full-screen takeover, independent of the feed shell.
  if (admin) {
    return (
      <Suspense fallback={null}>
        <AdminPanel onExit={() => setAdmin(false)} />
      </Suspense>
    );
  }

  return (
    <div className={styles.app}>
      <a href="#main" className="skip-link">
        Skip to stories
      </a>
      {!activeMarket && (
        <DevelopingWidget news={feed?.breaking} events={feed?.events} onOpenStory={openStory} />
      )}
      {nlEngaged && newsletterEnabled && !nlPromptDone && (
        <NewsletterPrompt
          visible={!!activeMarket && !footerNlInView}
          onClose={() => {
            markNlSnoozed('dismissed');
            setNlPromptDone(true);
          }}
          onIgnore={() => {
            // Auto-retracted after sitting ignored — snooze briefly, don't mark "seen"
            // forever, so it returns on a later visit (until the give-up cap).
            markNlSnoozed('ignored');
            setNlPromptDone(true);
          }}
          onSubscribed={() => {
            markNlSubscribed();
            setNlPromptDone(true);
          }}
        />
      )}
      <div className={styles.container}>
        <Header
          generatedAt={feed?.generatedAt ?? null}
          total={markets.length}
          pinned={!!activeMarket}
          onBack={activeMarket ? onBack : undefined}
          backLabel={sectionBackLabel(section)}
          query={!activeMarket ? query : undefined}
          onQuery={!activeMarket ? setQuery : undefined}
          accountOpen={overlay === 'account'}
          onAccountOpenChange={(o) => (o ? setOverlay('account') : closeOverlay())}
        />

        {status !== 'error' && !activeMarket && (
          <Controls
            section={section}
            onSection={onSection}
            query={query}
            onQuery={setQuery}
            categories={categories}
            category={category}
            onCategory={onCategory}
            hasInterests={interests.topics.length > 0}
            interestsOpen={showPicker}
            onEditInterests={() => openInterests('controls')}
          />
        )}

        {firstRun && signedIn && overlay !== 'personalize' && !activeMarket && (
          <WelcomeBanner
            onChoose={() => openInterests('welcome_banner')}
            onDismiss={() => interests.save(interests.topics)}
          />
        )}

        <main id="main" className={styles.feed} aria-label="Stories">
          {confirmResult && (
            <div className={styles.notice} role="status">
              <span>{confirmResult}</span>
              <button type="button" onClick={() => setConfirmResult(null)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
          {status === 'loading' && <LoadingState />}
          {status === 'error' && <ErrorState onRetry={() => void refresh()} />}
          {status === 'ready' &&
            (activeMarket ? (
              <ArticleView market={activeMarket} onBack={onBack} backLabel={sectionBackLabel(section)} />
            ) : (
              <>
                {section === 'top' && !query && !category && (
                  <CatchUp stories={catchUp} onOpen={openStory} />
                )}
                {section === 'past' && <Scoreboard markets={markets} />}
                {visible.length === 0 ? (
                  <EmptyState
                    message={
                      section === 'saved'
                        ? 'No saved stories yet — tap Save on any story to read it later.'
                        : markets.length === 0
                          ? 'The feed is updating — fresh stories land within a few minutes.'
                          : query
                            ? `No stories match “${query}.” Try a broader term, or browse a topic above.`
                            : 'No stories match your filters.'
                    }
                    action={
                      (query || category) && section !== 'saved'
                        ? {
                            label: 'Clear filters',
                            onClick: () => {
                              setQuery('');
                              setCategory(null);
                            },
                          }
                        : undefined
                    }
                  />
                ) : (
                  <>
                    {section === 'wall' ? (
                      // The Wall: one scannable league table over the SAME windowed
                      // list, so search/category filters + the LoadMore pager below
                      // apply unchanged.
                      <CrowdWall stories={visiblePage} onOpen={openArticle} />
                    ) : (
                      <div className={styles.list}>
                        {visiblePage.map((m, i) => (
                          <StoryCard
                            key={m.id}
                            market={m}
                            onOpen={openArticle}
                            lead={i === 0 && !query && !category}
                          />
                        ))}
                      </div>
                    )}
                    {visible.length > limit && (
                      <LoadMore
                        remaining={visible.length - limit}
                        step={PAGE}
                        onMore={() =>
                          setLimit((l) => {
                            const next = l + PAGE;
                            track('feed_load_more', { total_shown: next, page: Math.round(next / PAGE) });
                            return next;
                          })
                        }
                      />
                    )}
                    <div className="visually-hidden" role="status" aria-live="polite">
                      {announce}
                    </div>
                  </>
                )}
              </>
            ))}
        </main>

        {showPicker && (
          <Onboarding
            mode={firstRun ? 'welcome' : 'edit'}
            available={allTopics}
            initial={interests.topics}
            onSave={(topics) => {
              track('interests_saved', { count: topics.length, mode: firstRun ? 'welcome' : 'edit' });
              // Persist (re-ranks the feed to lead with the chosen topics), then close
              // back-symmetrically. closeOverlay pops the ?o=personalize entry, returning
              // to the underlying feed entry — which is 'top' on first run (the picker's
              // common path), so saving still lands the reader on their fresh feed. We
              // deliberately DON'T force setSection('top') here: a pop restores the
              // underlying entry's section, and an extra setSection would either be
              // overwritten by popstate or strand the overlay entry (re-openable via Back).
              interests.save(topics);
              closeOverlay();
            }}
            onSkip={() => {
              // A first-run skip ("See everything") still marks onboarding done so the
              // welcome banner doesn't return; a returning-user edit just closes. Order:
              // persist (no history effect) before the back-symmetric close.
              if (firstRun) interests.save(interests.topics);
              closeOverlay();
            }}
          />
        )}

        {newsletterEnabled && (
          <div ref={footerNlRef}>
            <NewsletterSignup categories={allTopics} />
          </div>
        )}

        <footer className={styles.footer}>
          <span>
            Markets via{' '}
            <a href="https://polymarket.com" target="_blank" rel="noopener noreferrer">
              Polymarket
            </a>{' '}
            &amp;{' '}
            <a href="https://kalshi.com" target="_blank" rel="noopener noreferrer">
              Kalshi
            </a>{' '}
            · News via Google News · Briefings by Groq
          </span>
          <span className={styles.footerLinks}>
            <a href={`${import.meta.env.BASE_URL}about`}>About</a>
            <a href={`${import.meta.env.BASE_URL}privacy`}>Privacy</a>
            <a href={`${import.meta.env.BASE_URL}terms`}>Terms</a>
            <a href={`${import.meta.env.BASE_URL}feed.xml`}>RSS</a>
            <a
              href="https://github.com/squireaintready/crowdtells"
              target="_blank"
              rel="noopener noreferrer"
            >
              Source
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}
