"use client";

import { useMemo } from "react";
import { CalendarDays, Check, Clock3, History, Moon, Sun, UserRound, X } from "lucide-react";
import Modal from "./Modal";
import { formatSessionDate, sessionMetrics, type Assignment, type Student } from "./StudentInsights";
import { AttendanceLegend } from "./InsightLegend";
import "./student-analytics.css";

function formatRecordedAt(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function assignmentAnchor(id: string) { return `reflection-history-${encodeURIComponent(id)}`; }

export default function StudentProfile({ student, assignments, onClose, mode = "full" }: { student: Student; assignments: Assignment[]; onClose: () => void; mode?: "full" | "history" | "insights" }) {
  const history = useMemo(() => assignments.filter(item => item.studentId === student.id).sort((a, b) => b.date.localeCompare(a.date) || (a.slot === b.slot ? 0 : a.slot === "lunch" ? -1 : 1) || (b.createdAt || "").localeCompare(a.createdAt || "") || a.id.localeCompare(b.id)), [student.id, assignments]);
  const metrics = sessionMetrics(history);
  const byId = new Map(assignments.map(assignment => [assignment.id, assignment]));
  const showMetrics = mode !== "history";
  const insightsOnly = mode === "insights";

  function linkedSession(id: string, direction: "from" | "to") {
    const linked = byId.get(id);
    return <div className="student-profile-reschedule"><History size={12} aria-hidden="true"/><span>Rescheduled {direction} {linked ? <a href={`#${assignmentAnchor(id)}`}>{formatSessionDate(linked.date)} · {linked.slot === "morning" ? "Morning break" : "Lunch break"}</a> : <span>session unavailable</span>}</span></div>;
  }

  return <Modal title={student.name} subtitle={`${student.grade || "No grade"} · ${student.className || "No class"} · ${showMetrics ? "Student profile" : "Reflection history"}`} onClose={onClose} wide>
    <div className="student-profile">
      <div className="student-profile-intro"><span className="student-profile-tag"><UserRound size={13}/>STUDENT RECORD</span>{student.active === false && <span className="student-profile-archived">Archived student</span>}<span className="student-profile-scope">All time · Full reflection history</span></div>
      {showMetrics && <>
        <div className="student-profile-metrics" aria-label="All-time reflection totals"><div><span>Assigned sessions</span><strong>{metrics.assigned}</strong><span className="student-profile-assigned-breakdown">{metrics.initial} initial · {metrics.followUp} follow-up</span></div><div><span>Present</span><strong className="insights-present-count">{metrics.present}</strong></div><div><span>Absent</span><strong className="insights-absent-count">{metrics.absent}</strong></div><div><span>Pending</span><strong className="insights-pending-count">{metrics.pending}</strong></div></div>
        <div className="student-profile-attendance"><div><span className="student-profile-attendance-label">Attendance rate</span><strong>{metrics.rate === null ? "—" : `${metrics.rate}%`}</strong><span>{metrics.recorded ? `${metrics.present} present / ${metrics.recorded} recorded sessions` : "No attendance recorded yet"}</span></div><p>Present ÷ (present + absent). Pending sessions are excluded. Each break counts as one session.</p></div>
      </>}
      <div className="student-profile-history-heading"><h3><History size={17}/>Reflection history</h3><span>{history.length} {history.length === 1 ? "session" : "sessions"} · Newest first</span></div>
      <AttendanceLegend/>
      {!history.length ? <div className="student-profile-empty"><CalendarDays size={30} strokeWidth={1.4}/><h3>No reflection sessions yet</h3><p>Assignments and attendance will appear here when a reflection is assigned to this student.</p></div> : <div className="student-profile-history-scroll"><table className={`student-profile-history ${insightsOnly ? "insight-profile-history" : ""}`}><caption className="sr-only">Complete reflection session history for {student.name}, newest first. Rescheduled sessions retain their original attendance record.</caption><thead><tr><th scope="col">Date & session</th><th scope="col">Status</th><th scope="col">{insightsOnly ? "Assigned by" : "Reason & assignment"}</th>{!insightsOnly && <th scope="col">Attendance record</th>}</tr></thead><tbody>{history.map(assignment => <tr key={assignment.id} id={assignmentAnchor(assignment.id)}>
        <td><strong className="student-profile-date">{formatSessionDate(assignment.date)}</strong><span className={`student-profile-slot ${assignment.slot}`} aria-label={`${assignment.slot === "morning" ? "Morning" : "Lunch"} break reflection`}>{assignment.slot === "morning" ? <Sun size={13}/> : <Moon size={12}/>} {assignment.slot === "morning" ? "Morning break" : "Lunch break"}</span>{assignment.rescheduledFromId && linkedSession(assignment.rescheduledFromId, "from")}{assignment.rescheduledToId && linkedSession(assignment.rescheduledToId, "to")}</td>
        <td><span className={`student-profile-status ${assignment.status}`}>{assignment.status === "present" ? <Check size={12}/> : assignment.status === "absent" ? <X size={12}/> : <Clock3 size={12}/>} {assignment.status === "present" ? "Present" : assignment.status === "absent" ? "Absent" : "Pending"}</span>{assignment.rescheduledToId && <span className="student-profile-retained-note">Original record retained</span>}</td>
        <td>{!insightsOnly && <p className="student-profile-reason">{assignment.reason?.trim() || "No reason recorded"}</p>}<span className="student-profile-attribution">{insightsOnly ? "" : "Assigned by "}{assignment.assignedBy?.trim() || "Staff member not recorded"}</span>{assignment.createdAt && <span className="student-profile-timestamp">{formatRecordedAt(assignment.createdAt)}</span>}</td>
        {!insightsOnly && <td>{assignment.attendanceRecordedBy || assignment.attendanceRecordedAt ? <><span className="student-profile-recorder">{assignment.attendanceRecordedBy || "Staff member not recorded"}</span>{assignment.attendanceRecordedAt && <span className="student-profile-timestamp">{formatRecordedAt(assignment.attendanceRecordedAt)}</span>}</> : <span className="student-profile-no-record">{assignment.status === "pending" ? "Awaiting attendance" : "Recorder not available"}</span>}</td>}
      </tr>)}</tbody></table></div>}
      {!!history.some(assignment => assignment.rescheduledFromId || assignment.rescheduledToId) && <p className="student-profile-history-note"><History size={13}/>Rescheduling adds a linked session. Earlier attendance records, including absences, stay in the history.</p>}
    </div>
    <div className="modal-footer student-profile-footer"><span>Each row is one reflection session.</span><button className="button secondary" onClick={onClose}>Close {showMetrics ? "profile" : "history"}</button></div>
  </Modal>;
}
