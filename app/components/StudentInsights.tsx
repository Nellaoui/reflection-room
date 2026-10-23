"use client";

import { useMemo, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpRight, BarChart3, Search, Users, X } from "lucide-react";
import InsightLegend, { assignmentLevel } from "./InsightLegend";
import "./student-analytics.css";

export type Student = { id: string; name: string; grade: string; className: string; active?: boolean };
export type Assignment = {
  id: string;
  studentId: string;
  date: string;
  slot: "morning" | "lunch";
  reason?: string;
  assignedBy?: string;
  status: "pending" | "present" | "absent";
  createdAt?: string;
  attendanceRecordedBy?: string | null;
  attendanceRecordedAt?: string | null;
  rescheduledFromId?: string | null;
  rescheduledToId?: string | null;
};

export function sessionMetrics(assignments: Assignment[]) {
  const present = assignments.filter(item => item.status === "present").length;
  const absent = assignments.filter(item => item.status === "absent").length;
  const pending = assignments.filter(item => item.status === "pending").length;
  const followUp = assignments.filter(item => !!item.rescheduledFromId).length;
  const recorded = present + absent;
  return { assigned: assignments.length, initial: assignments.length - followUp, followUp, present, absent, pending, recorded, rate: recorded ? Math.round(present / recorded * 100) : null };
}

export function formatSessionDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
}

type Period = "all" | "7" | "30";
type Ranking = "initial" | "absent";
type StudentRow = Student & ReturnType<typeof sessionMetrics>;

export default function StudentInsights({ students, assignments, onOpenStudent }: { students: Student[]; assignments: Assignment[]; onOpenStudent: (studentId: string) => void }) {
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("");
  const [className, setClassName] = useState("");
  const [period, setPeriod] = useState<Period>("all");
  const [ranking, setRanking] = useState<Ranking>("initial");
  const today = localDate(new Date());
  const grades = useMemo(() => [...new Set(students.map(student => student.grade))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [students]);
  const classes = useMemo(() => [...new Set(students.filter(student => !grade || student.grade === grade).map(student => student.className))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [students, grade]);

  const rows = useMemo(() => {
    const start = new Date(`${today}T12:00:00`);
    start.setDate(start.getDate() - (period === "7" ? 6 : 29));
    const startDate = localDate(start);
    const byStudent = new Map<string, Assignment[]>();
    for (const assignment of assignments) {
      if (period !== "all" && (assignment.date < startDate || assignment.date > today)) continue;
      const entries = byStudent.get(assignment.studentId) || [];
      entries.push(assignment);
      byStudent.set(assignment.studentId, entries);
    }
    const search = query.trim().toLowerCase();
    return students.filter(student => (!grade || student.grade === grade) && (!className || student.className === className) && (!search || `${student.name} ${student.grade} ${student.className}`.toLowerCase().includes(search)))
      .map(student => ({ ...student, ...sessionMetrics(byStudent.get(student.id) || []) }))
      .sort((a, b) => b[ranking] - a[ranking] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [students, assignments, query, grade, className, period, ranking, today]);

  const totalAssigned = rows.reduce((total, student) => total + student.assigned, 0);
  const totalInitial = rows.reduce((total, student) => total + student.initial, 0);
  const totalFollowUp = rows.reduce((total, student) => total + student.followUp, 0);
  const totalAbsent = rows.reduce((total, student) => total + student.absent, 0);
  const hasFilters = !!query || !!grade || !!className || period !== "all";

  function leadingStudents(metric: Ranking) {
    const max = Math.max(0, ...rows.map(student => student[metric]));
    return { count: max, students: max ? rows.filter(student => student[metric] === max).sort((a, b) => a.name.localeCompare(b.name)) : [] };
  }
  const mostAssigned = leadingStudents("initial");
  const mostAbsent = leadingStudents("absent");

  function leaderCard(leader: ReturnType<typeof leadingStudents>, emptyText: string) {
    const student = leader.students[0];
    return student ? <><button className="insights-leader-name" onClick={() => onOpenStudent(student.id)}>{student.name}<ArrowUpRight size={14}/></button><span className="insights-leader-detail">{leader.count} {leader.count === 1 ? "session" : "sessions"}{leader.students.length > 1 ? ` · Tied with ${leader.students.length - 1} ${leader.students.length === 2 ? "other student" : "other students"}` : ` · ${student.grade} / ${student.className}`}</span></> : <><strong className="insights-leader-empty">{emptyText}</strong><span className="insights-leader-detail">{rows.length ? "For the selected students and period" : "No students in the current view"}</span></>;
  }

  function clearFilters() { setQuery(""); setGrade(""); setClassName(""); setPeriod("all"); }
  const maxInitial = Math.max(0, ...rows.map(student => student.initial));
  const rankByCount = new Map(rows.map((student, index) => [student[ranking], index + 1] as const).reverse());

  return <section className="student-insights" aria-label="Student reflection insights">
    <div className="insights-filter-panel">
      <div className="insights-filter-intro"><span className="insights-section-kicker">STUDENT OVERVIEW</span><p>Explore reflection assignments and recorded attendance across the school.</p></div>
      <div className="insights-filters">
        <div className="insights-search"><Search size={17} aria-hidden="true"/><input aria-label="Search students in insights" placeholder="Search students…" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="Clear student search" onClick={() => setQuery("")}><X size={15}/></button>}</div>
        <label><span>Grade</span><select value={grade} onChange={event => { setGrade(event.target.value); setClassName(""); }}><option value="">All grades</option>{grades.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>Class</span><select value={className} onChange={event => setClassName(event.target.value)}><option value="">All classes</option>{classes.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>Period</span><select value={period} onChange={event => setPeriod(event.target.value as Period)}><option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label>
      </div>
      <p className="insights-period-note">{period === "all" ? "All time includes past and future assignments." : `From ${formatSessionDate((() => { const date = new Date(`${today}T12:00:00`); date.setDate(date.getDate() - (period === "7" ? 6 : 29)); return localDate(date); })())} through ${formatSessionDate(today)}. Future assignments are excluded.`}</p>
    </div>

    <div className="insights-summary-grid" aria-live="polite">
      <article className="insights-summary-card insights-total-card"><span className="insights-card-icon"><BarChart3 size={20}/></span><span className="insights-card-label">Total assigned sessions</span><strong className="insights-total">{totalAssigned.toLocaleString()}</strong><span className="insights-leader-detail">{totalInitial.toLocaleString()} initial · {totalFollowUp.toLocaleString()} follow-up</span><span className="insights-card-footnote">{rows.length.toLocaleString()} {rows.length === 1 ? "student" : "students"} · {totalAbsent.toLocaleString()} recorded {totalAbsent === 1 ? "absence" : "absences"}</span></article>
      <article className="insights-summary-card"><span className="insights-card-label">Most reflections assigned</span>{leaderCard(mostAssigned, "No initial sessions assigned")}<span className="insights-card-footnote">Initial sessions only. Follow-ups are excluded.</span></article>
      <article className="insights-summary-card insights-missed-card"><span className="insights-card-label">Most sessions missed</span>{leaderCard(mostAbsent, "No recorded absences")}<span className="insights-card-footnote">Counts sessions marked absent only.</span></article>
    </div>

    <InsightLegend/>
    <div className="register-section insights-ranking">
      <div className="section-heading insights-ranking-heading"><div className="section-title"><h2>Student ranking</h2><span className="count-badge">{rows.length}</span></div><label className="insights-ranking-control"><ArrowDownWideNarrow size={15} aria-hidden="true"/><span className="sr-only">Rank students by</span><select value={ranking} onChange={event => setRanking(event.target.value as Ranking)}><option value="initial">Most assigned</option><option value="absent">Most missed</option></select></label></div>
      <div className="insights-metric-note"><span>Most assigned ranks initial sessions only. Each break counts separately; follow-ups are shown separately.</span><span>Most missed counts every recorded absence. Attendance = present ÷ (present + absent); pending is excluded.</span></div>
      {!rows.length ? <div className="empty-state insights-empty"><div className="empty-art"><div><Users size={28} strokeWidth={1.4}/></div></div><h3>{students.length ? "No students match your filters" : "Your student insights start here"}</h3><p>{students.length ? "Try another name, grade or class." : "Add or import your school’s student roster to see individual reflection and attendance records."}</p>{hasFilters && <button className="button secondary" onClick={clearFilters}>Clear filters</button>}</div> : <div className="table-scroll"><table className="register-table insights-table"><caption className="sr-only">All matching students ranked by {ranking === "initial" ? "initial assigned sessions, excluding rescheduled follow-ups" : "recorded absences across initial and follow-up sessions"}. Equal counts share the same rank.</caption><thead><tr><th scope="col">Rank</th><th scope="col">Student</th><th scope="col">Grade / Class</th><th scope="col" aria-sort={ranking === "initial" ? "descending" : "none"}>Initial assigned</th><th scope="col">Follow-ups</th><th scope="col">Present</th><th scope="col" aria-sort={ranking === "absent" ? "descending" : "none"}>Absent</th><th scope="col">Pending</th><th scope="col">Attendance</th><th scope="col"><span className="sr-only">Student profile</span></th></tr></thead><tbody>{rows.map((student: StudentRow) => {
        const rank = rankByCount.get(student[ranking]) || 1;
        return <tr key={student.id}><td><span className={`insights-rank ${rank <= 3 && student[ranking] > 0 ? "insights-rank-leading" : ""}`}>{rank}</span></td><td><button className="insights-student-link table-student" onClick={() => onOpenStudent(student.id)}><span className="student-avatar" aria-hidden="true">{initials(student.name)}</span><span><strong>{student.name}</strong>{student.active === false && <span className="insights-archived">Archived</span>}</span></button></td><td><span className="insights-grade">{student.grade || "—"}</span><span className="insights-class">{student.className || "—"}</span></td><td><strong className={`insights-assigned-count assignment-count assignment-${assignmentLevel(student.initial, maxInitial)}`}>{student.initial}</strong></td><td><span className="insights-follow-up-count">{student.followUp}</span></td><td><span className="insights-present-count">{student.present}</span></td><td><span className={student.absent ? "insights-absent-count" : "insights-zero-count"}>{student.absent}</span></td><td><span className="insights-pending-count">{student.pending}</span></td><td><span className="insights-attendance-rate">{student.rate === null ? "—" : `${student.rate}%`}</span><span className="insights-attendance-denominator">{student.rate === null ? "No attendance recorded" : `${student.present} / ${student.recorded} recorded`}</span></td><td><button className="icon-button insights-open-profile" aria-label={`Open ${student.name}’s profile`} onClick={() => onOpenStudent(student.id)}><ArrowUpRight size={17}/></button></td></tr>;
      })}</tbody></table></div>}
      {!!rows.length && <div className="insights-table-footer"><span>Equal counts share the same rank. Student profiles include the full history.</span>{hasFilters && <button className="text-button" onClick={clearFilters}>Clear filters</button>}</div>}
    </div>
  </section>;
}
