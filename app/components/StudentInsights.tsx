"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
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

type Period = "all" | "7" | "30";

export default function StudentInsights({ students, assignments, onOpenStudent }: {
  students: Student[];
  assignments: Assignment[];
  onOpenStudent: (studentId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("");
  const [className, setClassName] = useState("");
  const [period, setPeriod] = useState<Period>("all");
  const today = localDate(new Date());
  const grades = useMemo(() => [...new Set(students.map(student => student.grade))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [students]);
  const classes = useMemo(() => [...new Set(students.filter(student => !grade || student.grade === grade).map(student => student.className))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [students, grade]);

  const absenceCounts = useMemo(() => {
    let startDate: string | null = null;
    if (period !== "all") {
      const start = new Date(`${today}T12:00:00`);
      start.setDate(start.getDate() - (Number(period) - 1));
      startDate = localDate(start);
    }
    const counts = new Map<string, number>();
    for (const assignment of assignments) {
      if (assignment.status !== "absent") continue;
      if (startDate && (assignment.date < startDate || assignment.date > today)) continue;
      counts.set(assignment.studentId, (counts.get(assignment.studentId) ?? 0) + 1);
    }
    return counts;
  }, [assignments, period, today]);

  const search = query.trim().toLowerCase();
  const rows = students.flatMap(student => {
    const absences = absenceCounts.get(student.id);
    if (!absences || (grade && student.grade !== grade) || (className && student.className !== className)) return [];
    if (search && !`${student.name} ${student.grade} ${student.className}`.toLowerCase().includes(search)) return [];
    return [{ ...student, absences }];
  }).sort((a, b) => b.absences - a.absences || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const hasFilters = Boolean(search || grade || className || period !== "all");

  function clearFilters() {
    setQuery("");
    setGrade("");
    setClassName("");
    setPeriod("all");
  }

  return <section className="student-insights" aria-label="Student reflection absences">
    <div className="insights-filter-panel">
      <div className="insights-filters">
        <div className="insights-search">
          <Search size={17} aria-hidden="true"/>
          <input aria-label="Search students in insights" placeholder="Search students…" value={query} onChange={event => setQuery(event.target.value)}/>
          {query && <button type="button" aria-label="Clear student search" onClick={() => setQuery("")}><X size={15}/></button>}
        </div>
        <label>
          <span>Grade</span>
          <select value={grade} onChange={event => { setGrade(event.target.value); setClassName(""); }}>
            <option value="">All grades</option>
            {grades.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>Class</span>
          <select value={className} onChange={event => setClassName(event.target.value)}>
            <option value="">All classes</option>
            {classes.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>Period</span>
          <select value={period} onChange={event => setPeriod(event.target.value as Period)}>
            <option value="all">All time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
      </div>
    </div>

    <div className="register-section">
      <div className="section-heading">
        <div className="section-title"><h2>Recorded absences</h2></div>
        {hasFilters && <button type="button" className="text-button" onClick={clearFilters}>Clear filters</button>}
      </div>
      {rows.length ? <div className="table-scroll">
        <table className="register-table student-absence-table">
          <caption className="sr-only">Recorded absences by student and class</caption>
          <thead>
            <tr>
              <th scope="col">Student</th>
              <th scope="col">Class</th>
              <th scope="col" aria-sort="descending">Absences</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(student => <tr key={student.id}>
              <td><button type="button" className="student-name-link" onClick={() => onOpenStudent(student.id)}>{student.name}</button></td>
              <td>{student.className || "—"}</td>
              <td><strong>{student.absences}</strong></td>
            </tr>)}
          </tbody>
        </table>
      </div> : <div className="empty-state insights-empty" role="status">
        <h3>{hasFilters ? "No recorded absences match your filters" : "No recorded absences"}</h3>
      </div>}
    </div>
  </section>;
}
