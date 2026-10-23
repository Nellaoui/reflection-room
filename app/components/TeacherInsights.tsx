"use client";

import { useMemo, useState } from "react";
import { BarChart3, Search, Users, X } from "lucide-react";
import { formatSessionDate, sessionMetrics, type Student } from "./StudentInsights";
import InsightLegend, { assignmentLevel } from "./InsightLegend";
import "./student-analytics.css";

export type { InsightTeacher, InsightAssignment } from "@/app/lib/reflection-insights";
import type { InsightTeacher, InsightAssignment } from "@/app/lib/reflection-insights";
type Period = "all" | "7" | "30";

function localDate(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }

export default function TeacherInsights({ students, assignments, teachers }: { students: Student[]; assignments: InsightAssignment[]; teachers: InsightTeacher[] }) {
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("");
  const [className, setClassName] = useState("");
  const [period, setPeriod] = useState<Period>("all");
  const today = localDate(new Date());
  const start = new Date(`${today}T12:00:00`);
  start.setDate(start.getDate() - (period === "7" ? 6 : 29));
  const startDate = localDate(start);
  const grades = useMemo(() => [...new Set(students.map(student => student.grade))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [students]);
  const classes = useMemo(() => [...new Set(students.filter(student => !grade || student.grade === grade).map(student => student.className))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [students, grade]);
  const rows = useMemo(() => {
    const studentMap = new Map(students.map(student => [student.id, student]));
    const byTeacher = new Map<string, InsightAssignment[]>();
    for (const assignment of assignments) {
      const student = studentMap.get(assignment.studentId);
      if ((grade && student?.grade !== grade) || (className && student?.className !== className)) continue;
      if (period !== "all" && (assignment.date < startDate || assignment.date > today)) continue;
      const entries = byTeacher.get(assignment.teacherId) || [];
      entries.push(assignment);
      byTeacher.set(assignment.teacherId, entries);
    }
    const search = query.trim().toLocaleLowerCase();
    return teachers.filter(teacher => !search || teacher.name.toLocaleLowerCase().includes(search)).map(teacher => {
      const sessions = byTeacher.get(teacher.id) || [];
      return { ...teacher, ...sessionMetrics(sessions), uniqueStudents: new Set(sessions.map(session => session.studentId)).size };
    }).sort((a, b) => b.initial - a.initial || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [students, assignments, teachers, query, grade, className, period, startDate, today]);
  const total = rows.reduce((sum, row) => sum + row.assigned, 0);
  const initial = rows.reduce((sum, row) => sum + row.initial, 0);
  const followUps = rows.reduce((sum, row) => sum + row.followUp, 0);
  const leader = rows.find(row => row.initial > 0);
  const tied = leader ? rows.filter(row => row.initial === leader.initial).length : 0;
  const maxInitial = Math.max(0, ...rows.map(teacher => teacher.initial));
  const rankByCount = new Map(rows.map((teacher, index) => [teacher.initial, index + 1] as const).reverse());
  const hasFilters = !!query || !!grade || !!className || period !== "all";
  function clearFilters() { setQuery(""); setGrade(""); setClassName(""); setPeriod("all"); }

  return <section className="student-insights teacher-insights" aria-label="Teacher reflection insights">
    <div className="insights-filter-panel">
      <div className="insights-filter-intro"><span className="insights-section-kicker">TEACHER OVERVIEW</span><p>See who assigns reflections and the attendance outcomes of those sessions.</p></div>
      <div className="insights-filters">
        <div className="insights-search"><Search size={17} aria-hidden="true"/><input aria-label="Search teachers in insights" placeholder="Search teachers…" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="Clear teacher search" onClick={() => setQuery("")}><X size={15}/></button>}</div>
        <label><span>Grade</span><select value={grade} onChange={event => { setGrade(event.target.value); setClassName(""); }}><option value="">All grades</option>{grades.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>Class</span><select value={className} onChange={event => setClassName(event.target.value)}><option value="">All classes</option>{classes.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>Period</span><select value={period} onChange={event => setPeriod(event.target.value as Period)}><option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label>
      </div>
      <p className="insights-period-note">{period === "all" ? "All time includes past and future assignments." : `${formatSessionDate(startDate)} – ${formatSessionDate(today)} · Future assignments excluded.`}</p>
    </div>
    <div className="insights-summary-grid">
      <article className="insights-summary-card insights-total-card"><span className="insights-card-icon"><BarChart3 size={20}/></span><span className="insights-card-label">Assigned sessions</span><strong className="insights-total">{total.toLocaleString()}</strong><span className="insights-leader-detail">{initial.toLocaleString()} initial · {followUps.toLocaleString()} follow-up</span></article>
      <article className="insights-summary-card"><span className="insights-card-label">Most reflections assigned</span><strong className="insights-leader-name teacher-leader-name">{leader?.name || "No initial sessions assigned"}</strong><span className="insights-leader-detail">{leader ? `${leader.initial} initial ${leader.initial === 1 ? "session" : "sessions"}${tied > 1 ? ` · ${tied} staff tied` : ""}` : "For the selected filters"}</span></article>
      <article className="insights-summary-card"><span className="insights-card-label">Staff in this view</span><strong className="insights-total">{rows.length}</strong><span className="insights-leader-detail">{rows.filter(row => row.assigned > 0).length} with assigned sessions</span></article>
    </div>
    <InsightLegend/>
    <div className="register-section insights-ranking">
      <div className="section-heading insights-ranking-heading"><div className="section-title"><h2>Teacher ranking</h2><span className="count-badge">{rows.length}</span></div><span className="insights-ranking-label">Most initial sessions assigned</span></div>
      <div className="insights-metric-note"><span>Both breaks count as two sessions. Follow-ups counted separately.</span><span>Outcomes belong to assigned sessions; they do not indicate who supervised them.</span></div>
      {!rows.length ? <div className="empty-state insights-empty"><div className="empty-art"><div><Users size={28}/></div></div><h3>No teachers match your filters</h3><p>Try another name or clear your filters.</p>{hasFilters && <button className="button secondary" onClick={clearFilters}>Clear filters</button>}</div> : <div className="table-scroll"><table className="register-table insights-table teacher-insights-table"><caption className="sr-only">Staff ranked by initial reflection sessions they assigned. Follow-ups are separate. Equal counts share the same rank.</caption><thead><tr><th scope="col">Rank</th><th scope="col">Teacher</th><th scope="col" aria-sort="descending">Initial assigned</th><th scope="col">Students</th><th scope="col">Follow-ups</th><th scope="col">Present</th><th scope="col">Absent</th><th scope="col">Pending</th></tr></thead><tbody>{rows.map(teacher => {
        const rank = rankByCount.get(teacher.initial) || 1;
        const accountLabel = teacher.deleted ? "Deleted account" : teacher.status === "disabled" ? "Disabled account" : teacher.role === "historical" ? "Historical staff" : teacher.role === "admin" ? "Admin" : teacher.role === "moderator" ? "Moderator" : "";
        return <tr key={teacher.id}><td><span className={`insights-rank ${rank <= 3 && teacher.initial > 0 ? "insights-rank-leading" : ""}`}>{rank}</span></td><td><div className="table-student"><span className="student-avatar" aria-hidden="true">{teacher.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase()}</span><span><strong>{teacher.name}</strong>{accountLabel && <span className="insights-account-note">{accountLabel}</span>}</span></div></td><td><strong className={`insights-assigned-count assignment-count assignment-${assignmentLevel(teacher.initial, maxInitial)}`}>{teacher.initial}</strong></td><td>{teacher.uniqueStudents}</td><td><span className="insights-follow-up-count">{teacher.followUp}</span></td><td><span className="insights-present-count">{teacher.present}</span></td><td><span className={teacher.absent ? "insights-absent-count" : "insights-zero-count"}>{teacher.absent}</span></td><td><span className="insights-pending-count">{teacher.pending}</span></td></tr>;
      })}</tbody></table></div>}
      <div className="insights-table-footer"><span>Includes current teacher accounts and historical staff who assigned sessions. Equal counts share a rank.</span>{hasFilters && <button className="text-button" onClick={clearFilters}>Clear filters</button>}</div>
    </div>
  </section>;
}
