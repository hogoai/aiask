"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CalendarDays, Sparkles } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { isAppLocale } from "../../i18n/config";
import type { WorkspaceRecords } from "../../lib/workspace/browser-records";
import { activeQuestion, advanceDailyState, buildDailyCheckIn, decodeDailyState, emptyDailyState, MAX_DAILY_ANSWER_LENGTH, recordedDailyAnswers, saveDailyAnswer, type BriefingItem, type DailyState } from "../../lib/workspace/daily-check-in";
import { dailyQuestionRole, isShortQuestion } from "../../lib/workspace/daily-question";
import { STALE_AFTER_DAYS } from "../../lib/workspace/smart-follow-up";
import { useWorkspaceAccount } from "./useWorkspaceAccount";
import "./daily-check-in.css";

type StoreUpdate = (state: DailyState) => DailyState;
const SNOOZE_MS = 60 * 60 * 1000;
const ANSWERS_PAGE_SIZE = 5;

function useDailyStore(userId: string | null) {
  const demo = userId === null;
  const key = "aiask-daily-check-in:v1:" + (demo ? "demo" : "user:" + userId);
  const [state, setState] = useState<DailyState | null>(null);
  const [storageError, setStorageError] = useState(false);
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const refresh = () => {
      try {
        setState(decodeDailyState(window.localStorage.getItem(key), demo));
        setStorageError(false);
      } catch { setStorageError(true); }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
    };
  }, [demo, key]);

  const mutate = useCallback(async (update: StoreUpdate) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return false;
    const write = () => {
      if (signal.aborted) return false;
      const storage = window.localStorage;
      const before = decodeDailyState(storage.getItem(key), demo);
      const after = update(before);
      if (before === after) return false;
      storage.setItem(key, JSON.stringify(after));
      setState(after);
      setStorageError(false);
      return true;
    };
    try {
      return navigator.locks ? await navigator.locks.request(key, { signal }, write) : write();
    } catch {
      if (!signal.aborted) setStorageError(true);
      return false;
    }
  }, [demo, key]);

  return { state, storageError, mutate, lifetime };
}

export default function DailyCheckIn({ records }: { records: WorkspaceRecords }) {
  const scope = useWorkspaceAccount();
  const t = useTranslations("dailyCheckIn");
  if (scope.status === "ready") {
    return <ScopedDailyCheckIn key={scope.userId ?? "demo"} records={records} userId={scope.userId} />;
  }
  return <section className="workspace-panel daily-check-in" aria-labelledby="daily-briefing-title">
    <h2 id="daily-briefing-title">{t("title")}</h2>
    <p role="status">{t(scope.status === "loading" ? "loading" : "scopeUnavailable")}</p>
  </section>;
}

function ScopedDailyCheckIn({ records, userId }: { records: WorkspaceRecords; userId: string | null }) {
  const t = useTranslations("dailyCheckIn");
  const locale = useLocale();
  const { state, storageError, mutate, lifetime } = useDailyStore(userId);
  const [now, setNow] = useState(() => new Date());
  const [notice, setNotice] = useState<"answered" | "replySaved" | "snoozed" | "dismissed" | "muted" | "unmuted" | null>(null);
  const [answerDraft, setAnswerDraft] = useState<{ key: string; text: string } | null>(null);
  const [savingAnswer, setSavingAnswer] = useState(false);
  const [answerLimit, setAnswerLimit] = useState(ANSWERS_PAGE_SIZE);
  const [enhancing, setEnhancing] = useState(false);
  const [aiUnavailable, setAiUnavailable] = useState(false);
  const modelRequest = useRef(false);
  const [canEnhance, setCanEnhance] = useState(false);
  const briefing = useMemo(() => buildDailyCheckIn(records, now), [records, now]);
  const answers = useMemo(() => recordedDailyAnswers(state), [state]);
  const allowed = state?.localDataAllowed ?? (userId === null);
  const enabled = state?.enabled ?? true;

  useEffect(() => {
    const refresh = () => setNow(new Date());
    let timer: number;
    const tick = () => {
      timer = window.setTimeout(() => {
        if (!document.hidden) refresh();
        tick();
      }, 60_000 - Date.now() % 60_000);
    };
    setCanEnhance(userId !== null && Boolean(navigator.locks));
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    tick();
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearTimeout(timer);
    };
  }, [userId]);

  useEffect(() => {
    if (state && allowed && enabled && !storageError) {
      void mutate(current => advanceDailyState(current, briefing.candidates, briefing.today, now.getTime()));
    }
  }, [allowed, briefing, enabled, mutate, now, state, storageError]);
  const loaded = state !== null;

  // Reconcile a change saved by another tab when it removes the active question.
  const selected = state && activeQuestion(state, briefing.candidates);
  const question = selected || (storageError && allowed && enabled ? briefing.candidates.find(item =>
    !state?.questions[item.key] && !state?.muted.includes(item.family)) : undefined);
  const entry = question ? state?.questions[question.key] : undefined;
  const editing = question && answerDraft?.key === question.key ? answerDraft : null;
  const savedWording = entry?.wording;
  const wording = question && savedWording?.locale === locale && savedWording?.kind === question.kind ? savedWording.question : null;
  const snoozedUntil = state && briefing.candidates.reduce<number | undefined>((earliest, item) => {
    const value = state.questions[item.key];
    return value?.status === "snoozed" && value.snoozedUntil && !state.muted.includes(item.family)
      ? Math.min(earliest ?? Infinity, value.snoozedUntil) : earliest;
  }, undefined);
  useEffect(() => {
    if (!enabled || !snoozedUntil || snoozedUntil <= now.getTime()) return;
    const timer = window.setTimeout(() => setNow(new Date()), Math.max(0, snoozedUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [enabled, now, snoozedUntil]);

  function formatDate(value: string) {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value + "T12:00:00"));
  }

  function formatWallTime(value: string) {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" }).format(new Date("2000-01-01T" + value + ":00Z"));
  }

  function sourceDetails(item: BriefingItem) {
    const date = item.date && formatDate(item.date);
    return [t(`sources.${item.source}`), date && (item.dateMeaning === "lastUpdate" ? t("lastUpdate", { date }) : date), item.time && formatWallTime(item.time)].filter(Boolean).join(" · ");
  }

  function itemTitle(item: BriefingItem) {
    if (!item.relatedTitles?.length) return item.title;
    const titles = new Intl.ListFormat(locale).format([item.title, ...item.relatedTitles.slice(0, 2)]);
    const remaining = item.relatedTitles.length - 2;
    return remaining > 0 ? t("moreEvents", { titles, count: remaining }) : titles;
  }

  async function resolve(status: "answered" | "snoozed" | "dismissed" | "muted") {
    if (!question) return;
    const changed = await mutate(current => {
      const existing = current.questions[question.key];
      if (!current.localDataAllowed || !current.enabled || existing?.status !== "pending" || current.muted.includes(question.family)) return current;
      if (status === "muted") return { ...current, muted: [...current.muted, question.family] };
      return { ...current, questions: { ...current.questions, [question.key]: { ...existing, status, snoozedUntil: status === "snoozed" ? Date.now() + SNOOZE_MS : undefined } } };
    });
    if (changed) {
      setAnswerDraft(null);
      setNotice(status);
    }
  }

  async function submitAnswer() {
    if (!question || !editing?.text.trim() || savingAnswer) return;
    setSavingAnswer(true);
    try {
      const saved = await mutate(current => saveDailyAnswer(current, question, editing.text, Date.now()));
      if (saved) {
        setAnswerDraft(null);
        setNotice("replySaved");
      }
    } finally {
      setSavingAnswer(false);
    }
  }

  async function enhance() {
    if (!question || !isAppLocale(locale) || !userId || !canEnhance || modelRequest.current) return;
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    modelRequest.current = true;
    setEnhancing(true);
    setAiUnavailable(false);
    try {
      const claimed = await mutate(current => {
        const existing = current.questions[question.key];
        if (!current.localDataAllowed || !current.enabled || current.muted.includes(question.family) || existing?.status !== "pending" ||
          existing.aiAttempted || current.lastAiDay === briefing.today) return current;
        return { ...current, lastAiDay: briefing.today, questions: { ...current.questions, [question.key]: { ...existing, aiAttempted: true } } };
      });
      if (!claimed || signal.aborted) return;
      const response = await fetch("/api/ai/run", {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "daily_question", kind: question.kind, locale, expectedUserId: userId }),
      });
      if (!response.ok) throw new Error("Question generation failed");
      const data: { question?: unknown } = await response.json();
      const text = data.question;
      if (!isShortQuestion(text)) throw new Error("Invalid question");
      await mutate(current => {
        const existing = current.questions[question.key];
        if (!current.enabled || current.muted.includes(question.family) || existing?.status !== "pending") return current;
        return { ...current, questions: { ...current.questions, [question.key]: { ...existing, wording: { locale, kind: question.kind, question: text } } } };
      });
    } catch {
      if (!signal.aborted) setAiUnavailable(true);
    } finally {
      modelRequest.current = false;
      if (!signal.aborted) setEnhancing(false);
    }
  }

  const groups = [
    { id: "dueToday", items: briefing.dueToday, link: "todos" },
    { id: "important", items: briefing.scheduled, link: "calendar" },
    { id: "dueSoon", items: briefing.dueSoon, link: null },
    { id: "followUps", items: briefing.followUps, link: null },
  ] as const;
  function listItems(items: BriefingItem[]) {
    return <ul>{items.map(item => <li key={item.key}>
      {item.kind ? <Link href={`/?view=${item.source}`}><strong>{itemTitle(item)}</strong></Link> : <strong>{itemTitle(item)}</strong>}
      <small>{[item.kind && t(`types.${item.kind}`), sourceDetails(item)].filter(Boolean).join(" · ")}</small>
    </li>)}</ul>;
  }

  return <div className="daily-check-in-stack">
    <section className="workspace-panel daily-check-in" aria-labelledby="daily-briefing-title">
      <div className="daily-check-in-heading">
        <div className="daily-check-in-icon"><CalendarDays size={19} aria-hidden="true" /></div>
        <div><h2 id="daily-briefing-title">{t("title")}</h2><p><time dateTime={briefing.today}>{formatDate(briefing.today)}</time> · {t("localBadge")}</p></div>
      </div>
      {!allowed ? <div className="daily-check-in-access">
        <p>{t(!loaded && !storageError ? "loading" : "localAccess")}</p>
        {loaded && <button type="button" className="daily-action primary" onClick={() => void mutate(current => current.localDataAllowed ? current : { ...current, localDataAllowed: true })}>{t("allowLocal")}</button>}
      </div> : <>
        {(records.planner.incomplete || records.ideas.incomplete) && <p className="daily-check-in-note" role="status">{t("incomplete")}</p>}
        <div className="daily-check-in-groups">
          {groups.map(group => <div className="daily-check-in-group" key={group.id}>
            <h3>{group.link ? <Link href={`/?view=${group.link}`}>{t(`groups.${group.id}`)}</Link> : t(`groups.${group.id}`)}</h3>
            {!group.items.length ? <p>{t("emptyGroup")}</p> : listItems(group.items.slice(0, 3))}
            {group.items.length > 3 && <details className="daily-check-in-more"><summary>{t("more", { count: group.items.length - 3 })}</summary>{listItems(group.items.slice(3))}</details>}
          </div>)}
        </div>
      </>}
      {storageError && <p className="daily-check-in-note" role="alert">{t("storageError")}</p>}
    </section>
    {allowed && (loaded || storageError) && <section className="workspace-panel daily-check-in daily-question" aria-labelledby="daily-question-title">
      <div className="daily-check-in-heading">
        <div className="daily-check-in-icon"><Sparkles size={19} aria-hidden="true" /></div>
        <div><h2 id="daily-question-title">{t("questionTitle")}</h2><p>{t("questionHint")}</p></div>
      </div>
      {question && enabled ? <div className="daily-question-body">
        <span className="daily-question-partner">{t(`roles.${dailyQuestionRole[question.kind]}`)}</span>
        <p className="daily-question-text" aria-live="polite">{wording ?? t(`questions.${question.kind}`)}</p>
        <p className="daily-question-fact">{t(`facts.${question.kind}`, { days: STALE_AFTER_DAYS })}</p>
        <Link className="daily-question-source" href={`/?view=${question.source}`}><strong>{itemTitle(question)}</strong><small>{sourceDetails(question)}</small></Link>
        {editing && <form className="daily-question-reply" onSubmit={event => { event.preventDefault(); void submitAnswer(); }}>
          <label htmlFor="daily-question-reply">{t("answerLabel")}</label>
          <textarea id="daily-question-reply" aria-describedby="daily-answer-local" maxLength={MAX_DAILY_ANSWER_LENGTH} rows={3}
            value={editing.text} disabled={savingAnswer} onChange={event => setAnswerDraft({ key: question.key, text: event.target.value })} />
          <p id="daily-answer-local">{t("answerPrivacy")}</p>
          <div className="daily-question-actions">
            <button type="submit" className="daily-action primary" disabled={!editing.text.trim() || savingAnswer}>{t("saveAnswer")}</button>
            <button type="button" className="daily-action" disabled={savingAnswer} onClick={() => setAnswerDraft(null)}>{t("cancelAnswer")}</button>
          </div>
        </form>}
        {entry?.status === "pending" && !storageError && <>
          {!editing && <div className="daily-question-actions">
            <button type="button" className="daily-action primary" onClick={() => setAnswerDraft({ key: question.key, text: "" })}>{t("answer")}</button>
            <button type="button" className="daily-action" onClick={() => void resolve("answered")}>{t("markHandled")}</button>
            <button type="button" className="daily-action" onClick={() => void resolve("snoozed")}>{t("snooze")}</button>
            <button type="button" className="daily-action" onClick={() => void resolve("dismissed")}>{t("dismiss")}</button>
            <button type="button" className="daily-action quiet" onClick={() => void resolve("muted")}>{t("mute")}</button>
          </div>}
          {!editing && canEnhance && (!entry.aiAttempted && state?.lastAiDay !== briefing.today || enhancing) && <div className="daily-question-enhance">
            <button type="button" className="daily-action" disabled={enhancing} onClick={() => void enhance()}>{t(enhancing ? "enhancing" : "enhance")}</button>
            <p>{t("enhancePrivacy")}</p>
          </div>}
          {aiUnavailable && <p className="daily-check-in-note" role="status">{t("aiUnavailable")}</p>}
        </>}
      </div> : <p className="daily-question-empty" role="status">
        {!enabled ? t("disabled") : snoozedUntil ? t("snoozeUntil", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(snoozedUntil) }) : t("noQuestion")}
      </p>}
      <div className="daily-question-settings">
        <label><input type="checkbox" checked={enabled} disabled={storageError} onChange={event => {
          const value = event.target.checked;
          void mutate(current => current.enabled === value ? current : { ...current, enabled: value });
        }} />{t("enabled")}</label>
        {Boolean(state?.muted.length) && <button className="daily-action quiet" type="button" disabled={storageError} onClick={async () => {
          if (await mutate(current => current.muted.length ? { ...current, muted: [] } : current)) setNotice("unmuted");
        }}>{t("unmute")}</button>}
      </div>
      {notice && <p className="daily-check-in-note" role="status">{t(`notices.${notice}`)}</p>}
      {answers.length > 0 && <details className="daily-question-history">
        <summary>{t("savedAnswers", { count: answers.length })}</summary>
        <ol>{answers.slice(0, answerLimit).map(answer => <li key={answer.key}>
          <small>{t(`types.${answer.kind}`)} · <time dateTime={new Date(answer.at).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(answer.at)}</time></small>
          <p>{answer.text}</p>
        </li>)}</ol>
        {answers.length > answerLimit && <button type="button" className="daily-action" onClick={() => setAnswerLimit(limit => limit + ANSWERS_PAGE_SIZE)}>{t("olderAnswers")}</button>}
      </details>}
    </section>}
  </div>;
}
