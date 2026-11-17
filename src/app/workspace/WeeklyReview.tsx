"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CalendarDays, Sparkles, TrendingUp } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { isAppLocale } from "../../i18n/config";
import type { WorkspaceRecords } from "../../lib/workspace/browser-records";
import { parseWeeklyCoachSummary, type WeeklyCoachFacts, type WeeklyCoachSummary } from "../../lib/workspace/weekly-coach";
import { buildWeeklyReview, type ReviewItem, type ReviewPeriod } from "../../lib/workspace/weekly-review";
import { useWorkspaceAccount } from "./useWorkspaceAccount";
import "./weekly-review.css";

const PAGE_SIZE = 4;
const MAX_CACHED_SUMMARIES = 4;
const consentKey = (userId: string) => "aiask-weekly-review-local:v1:" + userId;
const dateOnly = (value: string) => new Date(value + "T12:00:00Z");

export default function WeeklyReview({ records }: { records: WorkspaceRecords }) {
  const account = useWorkspaceAccount();
  const t = useTranslations("weeklyReview");
  if (account.status === "ready") {
    return <ReviewAccess key={account.userId ?? "demo"} records={records} userId={account.userId} />;
  }
  return <section className="workspace-panel weekly-review" aria-labelledby="weekly-review-title">
    <h2 id="weekly-review-title">{t("title")}</h2>
    <p className="weekly-review-note" role="status">{t(account.status === "loading" ? "loading" : "accountUnavailable")}</p>
  </section>;
}

function ReviewAccess({ records, userId }: { records: WorkspaceRecords; userId: string | null }) {
  const t = useTranslations("weeklyReview");
  const [allowed, setAllowed] = useState<boolean | null>(() => userId ? null : true);
  const [temporary, setTemporary] = useState(false);

  useEffect(() => {
    if (!userId) return;
    try { setAllowed(window.localStorage.getItem(consentKey(userId)) === "yes"); }
    catch { setAllowed(false); }
  }, [userId]);

  function allow() {
    if (!userId) return;
    try { window.localStorage.setItem(consentKey(userId), "yes"); }
    catch { setTemporary(true); }
    setAllowed(true);
  }

  if (allowed) return <ReviewContent records={records} userId={userId} temporary={temporary} />;
  return <section className="workspace-panel weekly-review" aria-labelledby="weekly-review-title">
    <h2 id="weekly-review-title">{t("title")}</h2>
    <p className="weekly-review-note">{t(allowed === null ? "loading" : "useLocalPrompt")}</p>
    {allowed === false && <button type="button" className="weekly-review-button" onClick={allow}>{t("useLocal")}</button>}
  </section>;
}

function useReviewClock() {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const refresh = () => {
      const now = new Date();
      setClock(now);
      window.clearTimeout(timer);
      const tomorrow = new Date(now);
      tomorrow.setHours(24, 0, 0, 0);
      timer = window.setTimeout(refresh, tomorrow.getTime() - now.getTime());
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return clock;
}

function ReviewContent({ records, userId, temporary }: { records: WorkspaceRecords; userId: string | null; temporary: boolean }) {
  const t = useTranslations("weeklyReview");
  const locale = useLocale();
  const [period, setPeriod] = useState<ReviewPeriod>("current");
  const clock = useReviewClock();
  const review = useMemo(() => buildWeeklyReview(records, clock, period), [records, clock, period]);
  const format = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }), [locale]);
  const range = format.formatRange(dateOnly(review.week.start), dateOnly(review.week.last));
  const following = format.formatRange(dateOnly(review.following.start), dateOnly(review.following.last));
  const groups = ["completed", "openDue", "scheduled", "ideaProgress", "needsFollowUp", "nextFocus"] as const;

  return <section className="workspace-panel weekly-review" aria-labelledby="weekly-review-title">
    <div className="weekly-review-header">
      <div className="weekly-review-title">
        <span className="weekly-review-icon"><TrendingUp size={19} aria-hidden="true" /></span>
        <div><h2 id="weekly-review-title">{t("title")}</h2><p className="weekly-review-note">{t("localSource")}</p></div>
      </div>
      <div className="weekly-review-periods" role="group" aria-label={t("selectWeek")}>
        {(["current", "previous"] as const).map(item => <button key={item} type="button" className="weekly-review-button" aria-pressed={period === item} onClick={() => setPeriod(item)}>{t(`periods.${item}`)}</button>)}
      </div>
    </div>
    <p className="weekly-review-range">
      <CalendarDays size={15} aria-hidden="true" />
      <strong>{range}</strong>
      <span>{t("asOf", { date: format.format(dateOnly(review.asOf)) })}</span>
    </p>
    {temporary && <p role="status" className="weekly-review-warning">{t("temporaryAccess")}</p>}
    {review.summaryFacts.partial && <p role="status" className="weekly-review-warning">{t("incomplete")}</p>}
    <div className="weekly-review-grid">
      {groups.map(group => <WeeklyGroup key={review.week.start + ":" + group} group={group} items={review.groups[group]}
        undated={review.summaryFacts.counts.undatedCompletions} following={following} />)}
    </div>
    <p className="weekly-review-note">{t("snapshotNote")}</p>
    <WeeklyCoach userId={userId} facts={review.summaryFacts} />
  </section>;
}

type Group = keyof ReturnType<typeof buildWeeklyReview>["groups"];

function WeeklyGroup({ group, items, following, undated }: { group: Group; items: ReviewItem[]; following: string; undated: number }) {
  const t = useTranslations("weeklyReview");
  const locale = useLocale();
  const format = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }), [locale]);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" }), [locale]);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const count = items.length;
  return <section className="weekly-review-group" aria-labelledby={`weekly-review-${group}`}>
    <div className="weekly-review-group-heading">
      <h3 id={`weekly-review-${group}`}>{t(`groups.${group}`)}</h3>
      <span aria-label={t("numberOfRecords", { count })}>{number.format(count)}</span>
    </div>
    <p className="weekly-review-note">{group === "nextFocus" ? t("followingRange", { range: following }) : t(`groupNotes.${group}`)}</p>
    {count ? <ul className="weekly-review-items">
      {items.slice(0, visible).map(item => {
        const date = item.date ? format.format(dateOnly(item.date)) : "";
        const dateLabel = item.kind === "staleTodo" || item.kind === "staleIdea" ? t("lastUpdate", { date }) : date;
        const time = item.time ? timeFormat.format(new Date("2000-01-01T" + item.time + ":00Z")) : "";
        const meta = [
          t(`sources.${item.source}`),
          group === "needsFollowUp" || group === "nextFocus" || item.kind === "openUndated" ? t(`kinds.${item.kind}`) : "",
          dateLabel, time,
          item.ideaStatus ? t(`ideaStatus.${item.ideaStatus}`) : "",
          item.priority === "urgent" || item.priority === "attention" ? t(`priority.${item.priority}`) : "",
        ].filter(Boolean).join(" · ");
        return <li key={item.source + ":" + item.key}>
          <Link href={`/?view=${item.source}`} className="weekly-review-record">{item.title}</Link>
          <small>{meta}</small>
          {item.nextStep && <p>{t("recordedNote", { note: item.nextStep })}</p>}
        </li>;
      })}
    </ul> : <p className="weekly-review-empty">{t("emptyGroup")}</p>}
    {count > visible && <button type="button" className="weekly-review-button" onClick={() => setVisible(limit => limit + PAGE_SIZE)}>{t("showMore", { count: count - visible })}</button>}
    {group === "completed" && undated > 0 && <p className="weekly-review-warning">{t("unknownCompletionDates", { count: undated })}</p>}
  </section>;
}

function cachedSummaries(key: string): [string, WeeklyCoachSummary][] {
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const entries: [string, WeeklyCoachSummary][] = [];
    for (const row of raw.slice(0, MAX_CACHED_SUMMARIES)) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      const summary = parseWeeklyCoachSummary(row[1]);
      if (summary) entries.push([row[0], summary]);
    }
    return entries;
  } catch { return []; }
}

function WeeklyCoach({ userId, facts }: { userId: string | null; facts: WeeklyCoachFacts }) {
  const t = useTranslations("weeklyReview.coach");
  const locale = useLocale();
  const cacheKey = "aiask-weekly-review-coach:v1:" + userId;
  const fingerprint = JSON.stringify([locale, facts]);
  const eligible = Object.values(facts.counts).some(count => count > 0);
  const [result, setResult] = useState<{ key: string; summary: WeeklyCoachSummary } | null>(null);
  const [status, setStatus] = useState<{ key: string; value: "pending" | "error" } | null>(null);
  const request = useRef<{ key: string; controller: AbortController } | null>(null);
  useEffect(() => {
    if (!userId) return;
    const cached = cachedSummaries(cacheKey).find(([key]) => key === fingerprint);
    setResult(cached ? { key: fingerprint, summary: cached[1] } : null);
    setStatus(null);
    return () => {
      if (request.current?.key === fingerprint) {
        request.current.controller.abort();
        request.current = null;
      }
    };
  }, [cacheKey, fingerprint, userId]);

  const summary = result?.key === fingerprint ? result.summary : null;
  const pending = status?.key === fingerprint && status.value === "pending";
  const failed = status?.key === fingerprint && status.value === "error";
  async function summarize() {
    if (!userId || !isAppLocale(locale) || !eligible || request.current || summary) return;
    const controller = new AbortController();
    request.current = { key: fingerprint, controller };
    setStatus({ key: fingerprint, value: "pending" });
    try {
      const response = await fetch("/api/ai/run", {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "weekly_review", expectedUserId: userId, locale, facts }),
      });
      if (!response.ok) throw new Error("Unavailable");
      const body: { summary?: unknown } = await response.json();
      const received = parseWeeklyCoachSummary(body.summary);
      if (!received) throw new Error("Invalid response");
      if (controller.signal.aborted) return;
      setResult({ key: fingerprint, summary: received });
      setStatus(null);
      try {
        const cached = cachedSummaries(cacheKey).filter(([key]) => key !== fingerprint);
        window.sessionStorage.setItem(cacheKey, JSON.stringify([[fingerprint, received], ...cached].slice(0, MAX_CACHED_SUMMARIES)));
      } catch { /* The result is already visible. */ }
    } catch {
      if (!controller.signal.aborted) setStatus({ key: fingerprint, value: "error" });
    } finally {
      if (request.current?.controller === controller) request.current = null;
    }
  }

  return <section className="weekly-review-coach" aria-labelledby="weekly-review-coach-title">
    <div><Sparkles size={17} aria-hidden="true" /><h3 id="weekly-review-coach-title">{t("title")}</h3></div>
    {summary ? <div className="weekly-review-summary" aria-live="polite">
      <p>{summary.reflection}</p>
      <p><strong>{t("possibleNextStep")}</strong> {summary.nextStep}</p>
    </div> : <p className="weekly-review-note">{t(!userId ? "localOnly" : !eligible ? "notEnoughData" : "sharing")}</p>}
    {userId && eligible && !summary && <button type="button" className="weekly-review-button" onClick={() => void summarize()} disabled={pending}>
      {t(pending ? "pending" : failed ? "retry" : "generate")}
    </button>}
    {failed && <p className="weekly-review-warning" role="status">{t("failed")}</p>}
  </section>;
}
