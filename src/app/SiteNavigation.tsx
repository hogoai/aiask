"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarDays, Check, FileText, Inbox, Menu, Plus, Sparkles, X } from "lucide-react";
import AccountControl from "./AccountControl";
import "./site-navigation.css";

type SiteNavigationProps = { active?: "about" | "partners" | "workspace" | "documents" };

export default function SiteNavigation({ active }: SiteNavigationProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return <header className="nav wrap shared-site-nav">
    <Link className="brand" href="/" aria-label="AIASK home" onClick={closeMenu}>
      <span className="brand-mark"><Sparkles size={17} /></span>aiask<span className="brand-dot">.</span>
    </Link>
    <button className="mobile-menu" type="button" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>
      {menuOpen ? <X size={21} /> : <Menu size={21} />}
    </button>
    <nav className={menuOpen ? "nav-links open" : "nav-links"} aria-label="Main navigation">
      <Link href="/partners" aria-current={active === "partners" ? "page" : undefined} onClick={closeMenu}>AI Team</Link>
      <Link href="/workspace" aria-current={active === "workspace" ? "page" : undefined} onClick={closeMenu}>My Workspace</Link>
      <Link className="nav-cta" href="/?view=calendar" onClick={closeMenu}><CalendarDays size={16} />Calendar</Link>
      <Link className="nav-cta" href="/?view=todos" onClick={closeMenu}><Check size={16} />To-do</Link>
      <Link className="nav-cta" href="/?view=inbox" onClick={closeMenu}><Inbox size={16} />Notes &amp; Ideas</Link>
      <Link className="nav-cta" href="/?view=documents" aria-current={active === "documents" ? "page" : undefined} onClick={closeMenu}><FileText size={16} />Letters &amp; Documents</Link>
      <Link className="nav-cta share-cta" href="/?capture=1" onClick={closeMenu}>Quick Capture <Plus size={16} /></Link>
      <AccountControl />
    </nav>
  </header>;
}
