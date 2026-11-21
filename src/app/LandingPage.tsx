"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowDown, ArrowRight, ArrowUpRight, BrainCircuit, CalendarDays, ChartNoAxesCombined,
  CheckCheck, Compass, Lightbulb, ListTodo, MessageCircleQuestion, MessageSquare, Sparkles,
} from "lucide-react";
import type { HomeView } from "../lib/home-navigation";
import { PARTNER_ROLE_ID } from "../lib/ai/contracts";
import ProactiveWorkflow from "./ProactiveWorkflow";
import "./landing.css";

type LandingPageProps = {
  onOpenView: (view: HomeView) => void;
  capture: ReactNode;
};

const tools = [
  { view: "calendar", title: "Calendar", label: "Make room for what matters.", icon: CalendarDays, text: "Keep your plans in view. Prepare for important events and pick up the follow-up afterward." },
  { view: "todos", title: "To-do", label: "A clear next step.", icon: ListTodo, text: "Give your actions a home. See what is coming up, what needs attention, and what you have already done." },
  { view: "inbox", title: "Notes & Ideas", label: "Capture Everything. Discover What Matters.", icon: Lightbulb, text: "Save a note, reflection, action item, or idea. Explore it with your AI Team when useful." },
] as const;

const teamPartners = [
  { id: PARTNER_ROLE_ID.guide, name: "Guide", icon: Sparkles, description: "Clarify direction and ask the right questions." },
  { id: PARTNER_ROLE_ID.planner, name: "Planner", icon: CalendarDays, description: "Plan steps, schedules and priorities." },
  { id: PARTNER_ROLE_ID.knowledgePartner, name: "Knowledge Partner", icon: BrainCircuit, description: "Bring knowledge and explore possibilities." },
  { id: PARTNER_ROLE_ID.evaluator, name: "Evaluator", icon: ChartNoAxesCombined, description: "Evaluate options, risks and progress." },
  { id: PARTNER_ROLE_ID.advisor, name: "Advisor", icon: Compass, description: "Offer advice and improve decisions." },
  { id: PARTNER_ROLE_ID.actionPartner, name: "Action Partner", icon: ArrowUpRight, description: "Clarify next steps and support action." },
] as const;

const ideaSteps = [
  { title: "Capture a spark", icon: Lightbulb },
  { title: "Explore with AI", icon: MessageCircleQuestion },
  { title: "Choose a next step", icon: ArrowUpRight },
] as const;

export default function LandingPage({ onOpenView, capture }: LandingPageProps) {
  return <div className="lp-page">
    <section className="lp-hero" id="top">
      <div className="lp-container">
        <span className="lp-eyebrow"><Sparkles size={14} aria-hidden="true" />Your proactive AI team</span>
        <h1>More than answers.<br /><em>AI that helps you<br className="lp-mobile-break" /> move forward.</em></h1>
        <p className="lp-hero-description">Your calendar, tasks, and ideas. One thoughtful AI team to help you see what matters and take the next step.</p>
        <div className="lp-actions">
          <a className="lp-button lp-button-primary" href="#workflow">Try proactive AI <ArrowRight size={16} /></a>
          <a className="lp-button lp-button-secondary" href="#roles">Meet your AI team <ArrowDown size={15} /></a>
        </div>
        <ul className="lp-highlights" aria-label="AIASK capabilities">
          <li><MessageCircleQuestion size={14} aria-hidden="true" />Proactive questions</li>
          <li><CheckCheck size={14} aria-hidden="true" />Daily check-ins</li>
          <li><ArrowUpRight size={14} aria-hidden="true" />Smart follow-up</li>
        </ul>
        <Link className="lp-workspace-hero-link" href="/workspace">Already have something in motion? Open My Workspace <ArrowRight size={14} aria-hidden="true" /></Link>
      </div>
    </section>

    <section className="lp-section lp-tools" id="tools">
      <div className="lp-container">
        <div className="lp-section-heading"><span className="lp-eyebrow">Three everyday essentials</span><h2>Everything starts here.</h2><p>Three simple tools. One proactive AI team.</p></div>
        <div className="lp-three-columns">
          {tools.map(({ view, title, label, icon: Icon, text }) => <button type="button" key={view} className="lp-tool-card" onClick={() => onOpenView(view)}>
            <div className="lp-card-top"><span className="lp-card-icon"><Icon size={22} aria-hidden="true" /></span><ArrowUpRight size={18} aria-hidden="true" /></div>
            <h3>{title}</h3><strong>{label}</strong><p>{text}</p>
          </button>)}
        </div>
      </div>
    </section>

    <section className="lp-section lp-team" id="roles" aria-labelledby="lp-team-title">
      <div className="lp-container">
        <div className="lp-section-heading">
          <span className="lp-eyebrow">My AI Team</span>
          <h2 id="lp-team-title">Six AI partners. Different perspectives. One shared goal.</h2>
          <p>Six complementary perspectives, connected through your ideas, plans, and progress.</p>
        </div>
        <div className="lp-three-columns">
          {teamPartners.map(({ id, name, icon: Icon, description }) =>
            <Link className="lp-partner-card" key={id} href={`/partners?partner=${id}#partner-detail`} aria-label={`Explore ${name}`}>
              <span className="lp-card-icon"><Icon size={21} aria-hidden="true" /></span>
              <h3>{name}</h3>
              <p>{description}</p>
            </Link>,
          )}
        </div>
      </div>
    </section>

    <section className="lp-section lp-workspace" id="my-workspace" aria-labelledby="lp-workspace-title">
      <div className="lp-container lp-workspace-grid">
        <div className="lp-workspace-copy">
          <span className="lp-eyebrow"><Compass size={15} aria-hidden="true" />My Workspace</span>
          <h2 id="lp-workspace-title">A place to keep moving.<br />And pick up where you left off.</h2>
          <p>Your AI Team helps you explore. My Workspace brings your ideas, actions, and saved AI conversations into view, with Proactive Insights to help you continue.</p>
          <ul className="lp-workspace-features">
            <li><Lightbulb size={18} aria-hidden="true" /><div><strong>See what’s taking shape</strong><span>Review your ideas, open actions, upcoming plans, and progress.</span></div></li>
            <li><MessageSquare size={18} aria-hidden="true" /><div><strong>Continue the conversation</strong><span>Return to a saved AI Team exchange or discuss a linked follow-up.</span></div></li>
            <li><CheckCheck size={18} aria-hidden="true" /><div><strong>Choose your next check-in</strong><span>Share an update, clarify what’s blocking you, and set a time to revisit it.</span></div></li>
          </ul>
          <Link className="lp-button lp-button-primary" href="/workspace">Open My Workspace <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
        <div className="lp-workspace-preview" aria-label="Example of a Workspace follow-up">
          <div className="lp-workspace-preview-header"><span><Sparkles size={16} aria-hidden="true" />Proactive Insights</span><small>Example check-in</small></div>
          <div className="lp-workspace-example-source"><ListTodo size={15} aria-hidden="true" />YOUR LINKED TASK</div>
          <h3>Prepare the client quotation</h3>
          <div className="lp-workspace-example-message"><strong>Your AI partner asks</strong><p>Have the final drawings and technical requirements been confirmed?</p></div>
          <div className="lp-workspace-example-message lp-workspace-example-reply"><strong>Your update</strong><p>The dimensions are confirmed. I’m still waiting for the final drawings.</p></div>
          <div className="lp-workspace-example-next"><CalendarDays size={18} aria-hidden="true" /><div><strong>A next step you choose</strong><p>Confirm the blocker and choose when to check in again.</p></div></div>
          <p className="lp-workspace-example-note">Keep the context. Continue when you’re ready.</p>
        </div>
      </div>
    </section>

    <section className="lp-workflow lp-section" id="workflow">
      <div className="lp-container" id="how">
        <div className="lp-section-heading"><span className="lp-eyebrow">Proactive workflow</span><h2>One task. A clear next step.</h2><p>Try a quick check-in, choose an action, and see how your AI team follows up.</p></div>
        <ProactiveWorkflow />
        <p className="lp-workspace-demo-link">Ready to try this with your own plans? <Link href="/workspace">Continue in My Workspace <ArrowRight size={14} aria-hidden="true" /></Link></p>
      </div>
    </section>

    <section className="lp-final" id="capture" aria-labelledby="lp-idea-title">
      <div className="lp-container">
        <span className="lp-eyebrow"><Lightbulb size={15} aria-hidden="true" />Idea Driver</span>
        <h2 id="lp-idea-title">Every idea starts somewhere.<br /><em>Let’s see where yours can go.</em></h2>
        <p>Capture a spark, explore it with your AI team, and shape it into a next step you choose.</p>
        <ol className="lp-idea-path" aria-label="Develop your idea">
          {ideaSteps.map(({ title, icon: Icon }, index) => <li key={title}>
            <span className="lp-idea-step-icon"><Icon size={16} aria-hidden="true" /></span>
            <span>{title}</span>
            {index < ideaSteps.length - 1 && <ArrowRight className="lp-idea-path-arrow" size={14} aria-hidden="true" />}
          </li>)}
        </ol>
        <div className="lp-capture">{capture}</div>
        <button type="button" className="lp-idea-link" onClick={() => onOpenView("inbox")}>Explore Notes &amp; Ideas <ArrowUpRight size={15} aria-hidden="true" /></button>
      </div>
    </section>

    <footer className="lp-footer lp-container">
      <Link className="lp-wordmark" href="/">AI<span>ASK</span><small>.app</small></Link>
      <span>© {new Date().getFullYear()} AIASK</span>
      <nav aria-label="Footer"><Link href="/about">About Us</Link><Link href="/partners">AI Team</Link><Link href="/workspace">My Workspace</Link></nav>
    </footer>
  </div>;
}
