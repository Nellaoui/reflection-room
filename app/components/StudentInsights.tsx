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
  reasonCategory?: string;
  assignedBy?: string;
  status: "pending" | "present" | "absent";
  createdAt?: string;
  attendanceRecordedBy?: string | null;
  attendanceRecordedAt?: string | null;
  rescheduledFromId?: string | null;
  rescheduledToId?: string | null;
  rescheduledToIds?: string[];
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
type SessionCounts = { assigned: number; present: number; absent: number };
export type InsightsDateRange = { start: string; end: string };

export default function StudentInsights({ students, assignments, onOpenStudent }: {
  students: Student[];
  assignments: Assignment[];
  onOpenStudent: (studentId: string, dateRange: InsightsDateRange | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("");
  const [className, setClassName] = useState("");
  const [period, setPeriod] = useState<Period>("all");
  const today = localDate(new Date());
  const grades = useMemo(() => [...new Set(students.map(student => student.grade))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [students]);
  const classes = useMemo(() => [...new Set(students.filter(student => !grade || student.grade === grade).map(student => student.className))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [students, grade]);

  const dateRange = useMemo(() => {
    if (period === "all") return null;
    const start = new Date(`${today}T12:00:00`);
    start.setDate(start.getDate() - (Number(period) - 1));
    return { start: localDate(start), end: today };
  }, [period, today]);

  const sessionCounts = useMemo(() => {
    const counts = new Map<string, SessionCounts>();
    for (const assignment of assignments) {
      if (dateRange && (assignment.date < dateRange.start || assignment.date > dateRange.end)) continue;
      const studentCounts = counts.get(assignment.studentId) ?? { assigned: 0, present: 0, absent: 0 };
      studentCounts.assigned++;
      if (assignment.status === "present") studentCounts.present++;
      if (assignment.status === "absent") studentCounts.absent++;
      counts.set(assignment.studentId, studentCounts);
    }
    return counts;
  }, [assignments, dateRange]);

  const search = query.trim().toLowerCase();
  const rows = students.flatMap(student => {
    const counts = sessionCounts.get(student.id);
    if (!counts || (grade && student.grade !== grade) || (className && student.className !== className)) return [];
    if (search && !`${student.name} ${student.grade} ${student.className}`.toLowerCase().includes(search)) return [];
    return [{ ...student, ...counts }];
  }).sort((a, b) => b.absent - a.absent || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const hasFilters = Boolean(search || grade || className || period !== "all");

  function clearFilters() {
    setQuery("");
    setGrade("");
    setClassName("");
    setPeriod("all");
  }

  return <section className="student-insights" aria-label="Student reflection insights">
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
        <div className="section-title"><h2>Reflection counts</h2></div>
        {hasFilters && <button type="button" className="text-button" onClick={clearFilters}>Clear filters</button>}
      </div>
      {rows.length ? <div className="table-scroll">
        <table className="register-table student-insights-table">
          <caption className="sr-only">Reflection assignments and attendance by student and class</caption>
          <thead>
            <tr>
              <th scope="col">Student</th>
              <th scope="col">Class</th>
              <th scope="col">Assigned</th>
              <th scope="col">Present</th>
              <th scope="col" aria-sort="descending">Absent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(student => <tr key={student.id}>
              <td><button type="button" className="student-name-link" onClick={() => onOpenStudent(student.id, dateRange)}>{student.name}</button></td>
              <td>{student.className || "—"}</td>
              <td>{student.assigned}</td>
              <td><strong className="insights-present-count">{student.present}</strong></td>
              <td><strong className="insights-absent-count">{student.absent}</strong></td>
            </tr>)}
          </tbody>
        </table>
      </div> : <div className="empty-state insights-empty" role="status">
        <h3>{hasFilters ? "No reflections match your filters" : "No reflections assigned"}</h3>
      </div>}
    </div>
  </section>;
}
