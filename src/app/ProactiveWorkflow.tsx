"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCheck, Clock3, FileText, ListTodo, RotateCcw, Sparkles } from "lucide-react";
import "./workflow.css";

type Step = 0 | 1 | 2;
type Answer = "drawings" | "ready" | "custom";
type Action = "draft" | "later" | "checklist";
type Outcome = "received" | "waiting";

const steps = ["Check requirements", "Choose a next step", "Follow up"] as const;
const checklistItems = ["Verify the quote’s line items", "Confirm quantities and pricing", "Check the delivery date"] as const;

export default function ProactiveWorkflow() {
  const [step, setStep] = useState<Step>(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [blocker, setBlocker] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customAnswer, setCustomAnswer] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState("");
  const [checkIn, setCheckIn] = useState("Tomorrow");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [checkedItems, setCheckedItems] = useState<string[]>([]);
  const questionRef = useRef<HTMLHeadingElement>(null);
  const view = `${step}:${outcome}`;
  const previousView = useRef(view);
  const ready = answer === "ready" || outcome === "received";
  const partner = step === 0 ? "AI Guide" : ready ? "AI Planner" : "AI Action Partner";
  const canContinue = action !== null && (action !== "draft" || Boolean(message.trim()));
  const hasPlan = answer !== null && canContinue;

  useEffect(() => {
    if (previousView.current !== view) questionRef.current?.focus();
    previousView.current = view;
  }, [view]);

  function restart() {
    setStep(0);
    setAnswer(null);
    setBlocker("");
    setCustomOpen(false);
    setCustomAnswer("");
    setAction(null);
    setMessage("");
    setCheckIn("Tomorrow");
    setOutcome(null);
    setCheckedItems([]);
  }

  function recordAnswer(value: Answer, detail = "") {
    setAnswer(value);
    setBlocker(detail);
    setCustomOpen(false);
    setAction(null);
    setMessage("");
    setOutcome(null);
    setCheckedItems([]);
    setCheckIn("Tomorrow");
    setStep(1);
  }

  function chooseAction(value: Action) {
    setAction(value);
    setOutcome(null);
    if (value === "draft" && !message) {
      setMessage(answer === "drawings"
        ? "Hi, could you share the final drawings and confirm when they’ll be available? I’m preparing the client quotation for Friday. Thank you."
        : `Hi, I’m preparing the client quotation for Friday. Could you help with this outstanding item: ${blocker}? Please let me know what is needed and when it may be ready. Thank you.`);
    }
  }

  function checklist() {
    return <div className="lp-workflow-checklist">
      {checklistItems.map(item => <label key={item}>
        <input type="checkbox" checked={checkedItems.includes(item)} onChange={event => {
          setCheckedItems(items => event.target.checked ? [...items, item] : items.filter(checked => checked !== item));
        }} />
        <span>{item}</span>
      </label>)}
      <p>{checkedItems.length} of {checklistItems.length} checks reviewed</p>
    </div>;
  }

  const taskStatus = answer === null ? "Needs a quick check" : ready ? "Ready for the next step" : "Waiting on information";
  const nextStep = outcome === "received" || action === "checklist"
    ? "Review the quotation checklist"
    : action === "draft" ? "Follow up on the missing information" : action === "later" ? `Check in ${checkIn.toLowerCase()}` : null;

  return <div className="lp-demo lp-workflow-demo">
    <div className="lp-workflow-header">
      <div className="lp-workflow-heading"><span className="lp-workflow-mark"><Sparkles size={19} aria-hidden="true" /></span><div><strong>See your AI team in action</strong><small>Try an example, one step at a time.</small></div></div>
      <button type="button" className="lp-workflow-reset" onClick={restart}><RotateCcw size={14} aria-hidden="true" />Start again</button>
    </div>

    <ol className="lp-workflow-steps" aria-label="Example workflow">
      {steps.map((label, index) => {
        const available = index === 0 || (index === 1 && answer !== null) || (index === 2 && hasPlan);
        return <li key={label}>
          <button type="button" disabled={!available} aria-current={step === index ? "step" : undefined} onClick={() => {
            setCustomOpen(false);
            if (index < 2) setOutcome(null);
            setStep(index as Step);
          }}>
            <span className={index < step ? "is-complete" : ""}>{index < step ? <Check size={14} aria-hidden="true" /> : index + 1}</span>
            {label}
          </button>
        </li>;
      })}
    </ol>

    <div className="lp-workflow-layout">
      <aside className="lp-workflow-context" aria-label="Example task details">
        <span className="lp-workflow-context-label"><ListTodo size={14} aria-hidden="true" />Example task</span>
        <h3>Submit the client quotation</h3>
        <dl className="lp-workflow-meta">
          <div><dt><CalendarDays size={13} aria-hidden="true" />Due</dt><dd>Friday</dd></div>
          <div><dt>Tool</dt><dd>To-do</dd></div>
        </dl>
        <p className={`lp-workflow-task-status${ready ? " is-ready" : ""}`}><span />{taskStatus}</p>

        <div className="lp-workflow-context-group">
          <h4>What your team knows</h4>
          <div className="lp-workflow-fact"><Check size={15} aria-hidden="true" /><div><strong>Client requirements</strong><span>Confirmed in this example</span></div></div>
          <div className="lp-workflow-fact">
            {ready ? <Check size={15} aria-hidden="true" /> : <Clock3 size={15} aria-hidden="true" />}
            <div><strong>{answer === "custom" ? "Outstanding information" : "Final drawings"}</strong><span>{answer === null ? "Ready to confirm" : ready ? "Confirmed by your answer" : blocker}</span></div>
          </div>
        </div>
        {nextStep && <div className="lp-workflow-context-group lp-workflow-recorded">
          <h4>Your chosen next step</h4><p>{nextStep}</p>
        </div>}
      </aside>

      <section className="lp-workflow-main" aria-labelledby="lp-workflow-question">
        <div className="lp-workflow-partner"><Sparkles size={15} aria-hidden="true" />{partner}</div>

        {step === 0 && <>
          <h3 id="lp-workflow-question" ref={questionRef} tabIndex={-1}>Is anything holding this task up?</h3>
          <p className="lp-workflow-explanation">Confirm whether any information is still missing before you prepare the quotation.</p>
          <div className="lp-workflow-choices">
            <button type="button" onClick={() => recordAnswer("drawings", "Waiting for the final drawings")}>
              <span><strong>I’m waiting for the drawings</strong><small>There is a missing detail to follow up on.</small></span><ArrowRight size={16} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => recordAnswer("ready")}>
              <span><strong>I have everything I need</strong><small>Help me check the quote and move forward.</small></span><ArrowRight size={16} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setCustomOpen(open => !open)} aria-expanded={customOpen} aria-controls="lp-workflow-custom">
              <span><strong>Something else is in the way</strong><small>Describe what you are waiting on.</small></span><ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
          {customOpen && <form className="lp-workflow-custom" id="lp-workflow-custom" onSubmit={event => {
            event.preventDefault();
            if (customAnswer.trim()) recordAnswer("custom", customAnswer.trim());
          }}>
            <label htmlFor="lp-workflow-answer">What is getting in the way?</label>
            <textarea id="lp-workflow-answer" maxLength={240} rows={2} value={customAnswer} onChange={event => setCustomAnswer(event.target.value)} placeholder="For example, I’m waiting for the client to confirm quantities." />
            <button type="submit" className="lp-workflow-primary" disabled={!customAnswer.trim()}>Choose a next step <ArrowRight size={15} /></button>
          </form>}
        </>}

        {step === 1 && <>
          <h3 id="lp-workflow-question" ref={questionRef} tabIndex={-1}>{ready ? "Let’s prepare a quote you can review." : "How would you like to move this forward?"}</h3>
          <p className="lp-workflow-explanation">{ready ? "Start with a short checklist before the quotation goes to your client." : `You recorded “${blocker}”. Choose the kind of support you want.`}</p>
          <div className="lp-workflow-action-options" role="group" aria-label="Choose support">
            {ready ? <button type="button" aria-pressed={action === "checklist"} onClick={() => chooseAction("checklist")}><CheckCheck size={16} />Review a checklist</button> : <>
              <button type="button" aria-pressed={action === "draft"} onClick={() => chooseAction("draft")}><FileText size={16} />Prepare a follow-up</button>
              <button type="button" aria-pressed={action === "later"} onClick={() => chooseAction("later")}><Clock3 size={16} />Check in later</button>
            </>}
          </div>
          {action === "draft" && <div className="lp-workflow-action-result">
            <label htmlFor="lp-workflow-message">Your follow-up draft</label>
            <textarea id="lp-workflow-message" maxLength={1200} rows={4} value={message} onChange={event => setMessage(event.target.value)} />
            <p>Edit the wording to make it your own.</p>
          </div>}
          {action === "later" && <div className="lp-workflow-action-result">
            <h4>When would you like to check in?</h4>
            <div className="lp-workflow-timing" role="group" aria-label="Example check-in timing">
              {["Tomorrow", "Next week"].map(time => <button type="button" key={time} aria-pressed={checkIn === time} onClick={() => setCheckIn(time)}>{time}</button>)}
            </div>
            <p>The next example check-in is set for {checkIn.toLowerCase()}.</p>
          </div>}
          {action === "checklist" && checklist()}
          <div className="lp-workflow-navigation">
            <button type="button" className="lp-workflow-back" onClick={() => setStep(0)}>Change my answer</button>
            <button type="button" className="lp-workflow-primary" disabled={!canContinue} onClick={() => { setOutcome(null); setStep(2); }}>
              {ready ? "Review progress" : "Try the next check-in"}<ArrowRight size={15} />
            </button>
          </div>
        </>}

        {step === 2 && <>
          {ready ? <>
            <h3 id="lp-workflow-question" ref={questionRef} tabIndex={-1}>Your next move is clear.</h3>
            <p className="lp-workflow-explanation">The information is ready. Review the remaining checks, then decide when to prepare the quotation.</p>
            {checklist()}
            <div className="lp-workflow-result-note"><Check size={16} aria-hidden="true" /><span>{checkedItems.length === checklistItems.length ? "Your example checklist is reviewed." : `${checklistItems.length - checkedItems.length} checks left to review.`}</span></div>
          </> : outcome === "waiting" ? <>
            <h3 id="lp-workflow-question" ref={questionRef} tabIndex={-1}>Still waiting? Adjust the next step.</h3>
            <p className="lp-workflow-explanation">The missing information stays in view. You can revise the follow-up or choose a later check-in.</p>
            <div className="lp-workflow-result-note is-waiting"><Clock3 size={16} aria-hidden="true" /><span>{blocker}</span></div>
            <button type="button" className="lp-workflow-primary" onClick={() => setStep(1)}>Revise my next step <ArrowRight size={15} /></button>
          </> : <>
            <h3 id="lp-workflow-question" ref={questionRef} tabIndex={-1}>Has the missing information arrived?</h3>
            <p className="lp-workflow-explanation">At your next check-in, your AI team returns to the detail you recorded.</p>
            <blockquote className="lp-workflow-recall">{blocker}</blockquote>
            <div className="lp-workflow-choices">
              <button type="button" onClick={() => setOutcome("received")}><span><strong>Yes, I have it now</strong><small>Move on to the quotation checklist.</small></span><ArrowRight size={16} aria-hidden="true" /></button>
              <button type="button" onClick={() => setOutcome("waiting")}><span><strong>I’m still waiting</strong><small>Keep the blocker in view and adjust the plan.</small></span><ArrowRight size={16} aria-hidden="true" /></button>
            </div>
          </>}
          {(ready || outcome === "waiting") && <div className="lp-workflow-navigation">
            <button type="button" className="lp-workflow-back" onClick={restart}>Try another path</button>
            <Link className="lp-workflow-open" href="/workspace">Use My Workspace <ArrowUpRight size={15} /></Link>
          </div>}
        </>}
      </section>
    </div>

    <div className="lp-workflow-footer"><span>Interactive example · Changes stay on this page.</span><Link href="/workspace">Try it with your own tasks <ArrowUpRight size={14} /></Link></div>
  </div>;
}
