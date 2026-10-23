"use client";

/* eslint-disable @next/next/no-img-element -- Use the same local school logo as the staff workspace. */
import { useState } from "react";
import { BookOpen, ChartNoAxesColumnIncreasing, GraduationCap, Menu, ShieldCheck, Users } from "lucide-react";
import InsightsPanel, { type InsightData, type InsightView } from "./InsightsPanel";

export default function InsightsWorkspace() {
  const [view, setView] = useState<InsightView>("students");
  const [mobileNav, setMobileNav] = useState(false);
  const [user, setUser] = useState<InsightData["user"] | null>(null);
  const [denied, setDenied] = useState(false);
  function changeView(next: InsightView) { setView(next); setMobileNav(false); }
  return <div className="app-shell insights-workspace">
    {mobileNav && <div className="mobile-scrim" onClick={() => setMobileNav(false)}/>}
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
      <a className="brand" href="/moderator" aria-label="Reflection Room insights"><div className="brand-symbol"><BookOpen size={23} strokeWidth={1.6}/><span/></div><div><strong>Reflection<span>Room</span></strong><small>SPACE TO RESET</small></div></a>
      <div className="workspace-label">SCHOOL INSIGHTS</div>
      <nav aria-label="Insights navigation"><button className={`nav-link ${view === "students" ? "active" : ""}`} onClick={() => changeView("students")}><ChartNoAxesColumnIncreasing size={19}/><span>Student insights</span></button><button className={`nav-link ${view === "teachers" ? "active" : ""}`} onClick={() => changeView("teachers")}><Users size={19}/><span>Teacher insights</span></button></nav>
      <div className="sidebar-bottom"><div className="school-profile"><div className="school-avatar"><img src="/school-logo.png" width={47} height={47} alt="London Academy school logo"/></div><div><strong>London Academy</strong><span>Bouskoura campus</span></div><ShieldCheck size={16}/></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={22}/></button><img className="topbar-logo" src="/school-logo.png" width={29} height={29} alt="London Academy"/><span className="topbar-school">London Academy</span><span className="topbar-divider">/</span><span>School insights</span></div><div className="topbar-right">{user && <span className={`role-badge ${user.role}`}><ShieldCheck size={12}/>{user.role === "admin" ? "Admin" : "Moderator"}</span>}<div className="user-info"><strong>{user?.name || "School staff"}</strong><span>{user?.email || "Reflection Room"}</span></div><form method="POST" action="/auth/logout" target="_top"><button className="text-button signout-link" type="submit">Sign out</button></form></div></header>
      <main className="main-content">
        {user && !denied && <div className="workspace-view-controls no-print"><nav className="workspace-view-switch" aria-label="Workspace view">{user.role === "admin" && <a href="/admin"><ShieldCheck size={14}/>Admin view</a>}<a href="/teacher"><GraduationCap size={15}/>Teacher view</a><a href="/moderator" aria-current="page"><ChartNoAxesColumnIncreasing size={14}/>Moderator view</a></nav></div>}
        <div className="page-heading"><div><div className="page-eyebrow"><span/>SCHOOL INSIGHTS</div><h1>{view === "students" ? "Student insights" : "Teacher insights"}<span className="heading-dot">.</span></h1><p>{view === "students" ? "Reflection patterns and recorded attendance." : "Reflection assignments across your school team."}</p></div><span className="insights-read-only"><ShieldCheck size={13}/>Read only</span></div>
        <InsightsPanel view={view} onUser={nextUser => { setUser(nextUser); setDenied(false); }} onAccessDenied={() => { setDenied(true); setUser(null); }}/>
        <footer className="page-footer"><span><BookOpen size={14}/> A little reflection. A positive way forward.</span><span>London Academy <i/> Bouskoura</span></footer>
      </main>
    </div>
  </div>;
}
