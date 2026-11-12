"use client";

import { useMemo, useState } from "react";
import { ArrowRight, CheckCheck, Search, X } from "lucide-react";

type Student = { id: string; name: string; grade: string; className: string };
type Assignment = { id: string; studentId: string; date: string; slot: "morning" | "lunch" };
const compare = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const labels = { morning: "Morning break", lunch: "Lunch break" };

function day(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function MissedReflections({ students, assignments, onOpenStudent, onReschedule }: {
  students: Student[];
  assignments: Assignment[];
  onOpenStudent: (studentId: string) => void;
  onReschedule: (assignment: Assignment) => void;
}) {
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("");
  const [className, setClassName] = useState("");
  const studentMap = useMemo(() => new Map(students.map(student => [student.id, student])), [students]);
  const unbooked = assignments.flatMap(assignment => {
    const student = studentMap.get(assignment.studentId);
    return student ? [{ assignment, student }] : [];
  });
  const grades = [...new Set(unbooked.map(({ student }) => student.grade))].sort(compare.compare);
  const classes = [...new Set(unbooked.filter(({ student }) => !grade || student.grade === grade).map(({ student }) => student.className))].sort(compare.compare);
  const search = query.trim().toLowerCase();
  const filtered = unbooked.filter(({ student }) =>
    (!search || `${student.name} ${student.grade} ${student.className}`.toLowerCase().includes(search))
    && (!grade || student.grade === grade)
    && (!className || student.className === className),
  ).sort((first, second) =>
    second.assignment.date.localeCompare(first.assignment.date) || compare.compare(first.student.name, second.student.name),
  );
  const hasFilters = !!(search || grade || className);

  function clearFilters() {
    setQuery("");
    setGrade("");
    setClassName("");
  }

  return <section className="register-section" aria-label="Unbooked reflections">
    <div className="section-heading">
      <div className="section-title"><h2>Unbooked reflections</h2><span className="count-badge">{filtered.length}</span></div>
    </div>
    <div className="register-filters">
      <div className="search-field">
        <Search size={17}/>
        <input aria-label="Search unbooked reflections" placeholder="Search students…" value={query} onChange={event => setQuery(event.target.value)}/>
        {query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X size={14}/></button>}
      </div>
      <select aria-label="Filter unbooked reflections by grade" value={grade} onChange={event => { setGrade(event.target.value); setClassName(""); }}>
        <option value="">All grades</option>
        {grades.map(value => <option key={value}>{value}</option>)}
      </select>
      <select aria-label="Filter unbooked reflections by class" value={className} onChange={event => setClassName(event.target.value)}>
        <option value="">All classes</option>
        {classes.map(value => <option key={value}>{value}</option>)}
      </select>
    </div>
    {filtered.length ? <div className="table-scroll">
      <table className="register-table missed-table">
        <thead><tr><th>Student</th><th>Grade / Class</th><th>Missed session</th><th>Follow-up</th></tr></thead>
        <tbody>{filtered.map(({ assignment, student }) => <tr key={assignment.id}>
          <td><button type="button" className="student-name-link" onClick={() => onOpenStudent(student.id)}>{student.name}</button></td>
          <td><span className="grade-text">{student.grade}</span><span className="table-class">{student.className}</span></td>
          <td><strong className="missed-date">{day(assignment.date)}</strong><span className={`slot-pill ${assignment.slot}`}>{labels[assignment.slot]}</span></td>
          <td><button type="button" className="button secondary small reschedule-button" onClick={() => onReschedule(assignment)}>Choose lunch date <ArrowRight size={13}/></button></td>
        </tr>)}</tbody>
      </table>
    </div> : <div className="empty-state">
      <div className="empty-art"><div><CheckCheck size={28} strokeWidth={1.4}/></div></div>
      <h3>{hasFilters ? "No unbooked reflections match" : "All follow-ups are booked"}</h3>
      {hasFilters && <button type="button" className="button secondary" onClick={clearFilters}>Clear filters</button>}
    </div>}
  </section>;
}
