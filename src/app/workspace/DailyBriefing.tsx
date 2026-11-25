"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { WorkspaceRecords } from "../../lib/workspace/browser-records";
import { buildDailyCheckIn, recordedDailyAnswers, type BriefingItem } from "../../lib/workspace/daily-check-in";
import { useWorkspaceAccount } from "./useWorkspaceAccount";
import { useDailyCheckInStore } from "./useDailyCheckInStore";
import "./daily-check-in.css";

export default function DailyBriefing({ records }: { records: WorkspaceRecords }) {
  const scope = useWorkspaceAccount();
  const t = useTranslations("dailyCheckIn");
  if (scope.status === "ready") return <ScopedBriefing key={scope.userId ?? "demo"} userId={scope.userId} records={records} />;
  return <section className="workspace-panel daily-check-in" aria-labelledby="daily-briefing-title"><h2 id="daily-briefing-title">{t("title")}</h2><p role="status">{t(scope.status === "loading" ? "loading" : "scopeUnavailable")}</p></section>;
}

function ScopedBriefing({ records, userId }: { records: WorkspaceRecords; userId: string | null }) {
  const t = useTranslations("dailyCheckIn");
  const locale = useLocale();
  const { state, storageError, mutate } = useDailyCheckInStore(userId);
  const [now, setNow] = useState(() => new Date());
  const briefing = useMemo(() => buildDailyCheckIn(records, now), [records, now]);
  const answers = useMemo(() => recordedDailyAnswers(state), [state]);
  const allowed = state?.localDataAllowed ?? (userId === null);
  const onlyOverdueFollowUps = briefing.followUps.length > 0 && briefing.followUps.every(item => item.kind === "overdue");
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setNow(new Date()); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.clearInterval(timer); };
  }, []);
  const formatDate = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value + "T12:00:00"));
  function list(items: BriefingItem[]) {
    return <ul>{items.map(item => {
      const title = item.relatedTitles?.length ? new Intl.ListFormat(locale).format([item.title, ...item.relatedTitles]) : item.title;
      const date = item.date && formatDate(item.date);
      const time = item.time && new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" }).format(new Date("2000-01-01T" + item.time + ":00Z"));
      return <li key={item.key}><Link href={`/?view=${item.source}`}><strong>{title}</strong></Link>
        <small>{[item.kind && t(`types.${item.kind}`), t(`sources.${item.source}`), date && (item.dateMeaning === "lastUpdate" ? t("lastUpdate", { date }) : date), time].filter(Boolean).join(" · ")}</small>
        {item.sourceDocumentId && <small><Link href={`/?view=documents&documentId=${encodeURIComponent(item.sourceDocumentId)}`}>Open source document</Link></small>}</li>;
    })}</ul>;
  }
  const groups = [{ id: "dueToday", items: briefing.dueToday }, { id: "important", items: briefing.scheduled }, { id: "dueSoon", items: briefing.dueSoon }, { id: "followUps", items: briefing.followUps }] as const;
  return <section className="workspace-panel daily-check-in" aria-labelledby="daily-briefing-title">
    <div className="daily-check-in-heading"><div className="daily-check-in-icon"><CalendarDays size={19} aria-hidden="true" /></div><div><h2 id="daily-briefing-title">{t("title")}</h2><p><time dateTime={briefing.today}>{formatDate(briefing.today)}</time> · {t("localBadge")}</p></div></div>
    {!allowed ? <div className="daily-check-in-access"><p>{t(!state && !storageError ? "loading" : "localAccess")}</p>
      {state && <button className="daily-action primary" type="button" onClick={() => void mutate(current => current.localDataAllowed ? current : { ...current, localDataAllowed: true })}>{t("allowLocal")}</button>}</div>
      : <>
        {(records.planner.incomplete || records.ideas.incomplete) && <p className="daily-check-in-note" role="status">{t("incomplete")}</p>}
        <div className="daily-check-in-groups">{groups.map(group => <div className="daily-check-in-group" key={group.id}><h3>{group.id === "followUps" && onlyOverdueFollowUps ? t("groups.overdueTasks") : t(`groups.${group.id}`)}</h3>
          {group.items.length ? list(group.items.slice(0, 3)) : <p>{t("emptyGroup")}</p>}
          {group.items.length > 3 && <details className="daily-check-in-more"><summary>{t("more", { count: group.items.length - 3 })}</summary>{list(group.items.slice(3))}</details>}
        </div>)}</div>
        {answers.length > 0 && <LegacyCheckInReplies answers={answers} locale={locale} />}
      </>}
    {storageError && <p className="daily-check-in-note" role="alert">{t("storageError")}</p>}
  </section>;
}

/** Read-only history: no migration, model call, old reminder activation, or original-record mutation. */
export function LegacyCheckInReplies({ answers, locale = "en" }: { answers: ReturnType<typeof recordedDailyAnswers>; locale?: string }) {
  const [limit, setLimit] = useState(5);
  return <details className="daily-question-history"><summary>Earlier check-in replies ({answers.length})</summary>
    <p>These replies are kept as read-only history. New questions and follow-up are managed in Proactive Insights.</p>
    <ol>{answers.slice(0, limit).map(answer => <li key={answer.key}><small><time dateTime={new Date(answer.at).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(answer.at)}</time></small><p>{answer.text}</p></li>)}</ol>
    {answers.length > limit && <button type="button" className="daily-action" onClick={() => setLimit(value => value + 5)}>Show older replies</button>}
  </details>;
}
