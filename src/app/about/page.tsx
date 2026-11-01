import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, BrainCircuit, Check, Compass, MessageCircleQuestion, ShieldCheck, Target, Users, Workflow } from "lucide-react";
import SiteNavigation from "../SiteNavigation";
import "./about.css";

export const metadata: Metadata = {
  title: "About AIASK — Your AI team",
  description: "Learn how AIASK brings people and AI together to think clearly, make thoughtful decisions, and move forward.",
};

const principles = [
  { number: "01", title: "Initiative, not just obedience", copy: "AI should notice relevant questions, opportunities, and risks instead of waiting for every instruction." },
  { number: "02", title: "Honest perspectives, not automatic agreement", copy: "AI should question assumptions, identify trade-offs, and respectfully disagree when evidence or reasoning calls for it." },
  { number: "03", title: "Shared progress, not task completion alone", copy: "The goal is to help people make thoughtful decisions, take meaningful action, learn from outcomes, and improve over time." },
];

const roles = [
  { icon: MessageCircleQuestion, name: "AI Guide", local: "引导者", copy: "Clarifies needs and goals through thoughtful questions." },
  { icon: Workflow, name: "AI Planner", local: "规划师", copy: "Shapes realistic plans, priorities, tasks, and schedules." },
  { icon: BrainCircuit, name: "AI Knowledge Specialist", local: "知识专员", copy: "Explains relevant fields and concepts, connects ideas, and marks where evidence needs checking." },
  { icon: Check, name: "AI Evaluator", local: "评估者", copy: "Reviews progress, evaluates outcomes, identifies gaps, and suggests corrections." },
  { icon: Compass, name: "AI Advisor", local: "顾问", copy: "Compares options, explores opportunities and risks, and offers independent recommendations." },
  { icon: Target, name: "AI Action Coach", local: "行动教练", copy: "Turns intentions into small, user-chosen actions and helps reduce friction when starting." },
];

const flow = ["Capture a thought", "Clarify what matters", "Explore possibilities", "Plan together", "Take action", "Review and improve"];

export default function AboutPage() {
  return <main className="about-page">
    <SiteNavigation active="about" />

    <section className="about-hero about-wrap" aria-labelledby="about-title">
      <div className="about-hero-copy">
        <p className="about-kicker">A DIFFERENT KIND OF AI</p>
        <h1 id="about-title">Not an AI that takes over.<br /><em>Your team for clearer thinking.</em></h1>
        <p className="about-lead">AIASK is built on a different idea: AI should not simply wait for instructions or blindly execute tasks. It should help people think more clearly, challenge assumptions, make better decisions, and turn intentions into meaningful action.</p>
        <div className="about-actions"><Link className="about-button about-button-dark" href="/#how">Explore how AIASK works <ArrowRight size={15} /></Link><a className="about-text-link" href="#roles">Meet the six roles <ArrowDown size={14} /></a></div>
      </div>
      <aside className="partnership-card" aria-label="Human and AI collaboration">
        <span className="partnership-icon"><Users size={21} /></span>
        <p>HUMAN + AI COLLABORATION</p>
        <h2>More perspective.<br /><em>More purposeful progress.</em></h2>
        <div className="partnership-rule"><span>People</span><i aria-hidden="true">↔</i><span>AIASK</span></div>
      </aside>
      <a className="about-scroll" href="#beliefs" aria-label="Scroll to what we believe"><span>SCROLL TO EXPLORE</span><ArrowDown size={14} /></a>
    </section>

    <section className="about-section about-beliefs" id="beliefs">
      <div className="about-wrap">
        <div className="about-section-heading"><p className="about-kicker">WHAT WE BELIEVE</p><h2>Better AI starts with<br /><em>a better relationship.</em></h2></div>
        <div className="principle-grid">{principles.map(item => <article className="principle-card" key={item.number}><span>{item.number}</span><h3>{item.title}</h3><p>{item.copy}</p></article>)}</div>
      </div>
    </section>

    <section className="about-section about-side-by-side">
      <div className="about-wrap side-by-side-layout">
        <div><p className="about-kicker">HUMAN + AI</p><h2>Different strengths.<br /><em>One shared direction.</em></h2><p className="section-intro">A collaborative relationship works best when each side brings what it does well, with people in control of the direction.</p></div>
        <div className="strength-columns"><article><span className="strength-label">PEOPLE BRING</span><h3>What matters to you.</h3><p>Values, lived experience, priorities, creativity, and responsibility for final decisions.</p></article><article><span className="strength-label">AI CONTRIBUTES</span><h3>Another useful perspective.</h3><p>Analysis, knowledge connections, alternative perspectives, structured planning, reviews, and timely reminders.</p></article></div>
        <div className="partnership-flow" aria-label="Human perspective and AI perspective lead to shared understanding, thoughtful action, and learning and improvement"><span>Human perspective</span><b aria-hidden="true">↔</b><span>AI perspective</span><b aria-hidden="true">→</b><span>Shared understanding</span><b aria-hidden="true">→</b><span>Thoughtful action</span><b aria-hidden="true">→</b><span>Learning &amp; improvement</span></div>
        <p className="agency-note">Neither side needs to be framed as a boss or a subordinate. People retain control over goals, permissions, and consequential decisions.</p>
      </div>
    </section>

    <section className="about-section about-roles" id="roles">
      <div className="about-wrap">
        <div className="about-section-heading"><p className="about-kicker">ONE COORDINATED EXPERIENCE</p><h2>Six ways to support<br /><em>your thinking and actions.</em></h2><p className="section-intro">These are complementary roles in one AI experience, sharing relevant context rather than operating as six disconnected products.</p></div>
        <div className="about-role-grid">{roles.map(({ icon: Icon, name, local, copy }, index) => <article className="about-role-card" key={name}><div className="about-role-top"><span>0{index + 1}</span><Icon size={19} aria-hidden="true" /></div><div className="about-role-name">{name}<span>{local}</span></div><p>{copy}</p></article>)}</div>
      </div>
    </section>

    <section className="about-section about-workflow" id="how">
      <div className="about-wrap workflow-layout"><div><p className="about-kicker">HOW AIASK WORKS</p><h2>From a thought<br /><em>to meaningful progress.</em></h2><p className="section-intro">Start with an unfinished thought, a question, a personal goal, or a work challenge. AIASK helps find an appropriate next step without forcing every idea to become a project or commercial opportunity.</p></div>
        <ol className="workflow-list">{flow.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span><b>{step}</b>{index < flow.length - 1 && <ArrowRight size={15} aria-hidden="true" />}</li>)}</ol>
        <p className="workflow-footnote">Planning, reminders, knowledge, evaluation, and correction are connected parts of the same experience.</p>
      </div>
    </section>

    <section className="about-section about-trust">
      <div className="about-wrap trust-layout"><div><p className="about-kicker">TRUST &amp; HUMAN AGENCY</p><h2>Support without<br /><em>taking over.</em></h2><p className="section-intro">Good AI support strengthens your judgment and agency. It does not replace them.</p></div><ul className="trust-list"><li><ShieldCheck size={17} /> You remain in control of your goals and priorities.</li><li><ShieldCheck size={17} /> AI should explain its reasoning and acknowledge uncertainty.</li><li><ShieldCheck size={17} /> Important actions require appropriate user authorization.</li><li><ShieldCheck size={17} /> You can challenge recommendations, revise plans, pause follow-ups, or decline suggestions.</li><li><ShieldCheck size={17} /> Action support should help without becoming intrusive or controlling.</li></ul></div>
    </section>

    <section className="about-closing"><div className="about-wrap"><p className="about-kicker">YOUR AI TEAM FOR THE WAY FORWARD</p><h2>Think together.<br /><em>Move forward.</em></h2><p>You bring the questions, ambitions, and experience. AIASK brings another perspective, thoughtful guidance, and support for the journey ahead.</p><div className="about-actions"><Link className="about-button about-button-light" href="/#top">Start with a thought <ArrowRight size={15} /></Link><Link className="about-closing-link" href="/#how">Explore AIASK <ArrowUpRight size={14} /></Link></div></div></section>
  </main>;
}
