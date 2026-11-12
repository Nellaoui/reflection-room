"use client";

/* eslint-disable @next/next/no-img-element -- Fixed-size local school logo uses a native image to avoid the observed Vinext image-runtime hook failure. */

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Archive, ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, CalendarClock, CalendarDays, ChartNoAxesColumnIncreasing, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardCheck, FileText, GraduationCap, History, LayoutDashboard, ListChecks, LoaderCircle, MapPin, Menu, Pencil, Plus, Printer, RotateCcw, Search, ShieldCheck, Sparkles, Sun, Trash2, Upload, UserRoundCog, Users, Utensils, X } from "lucide-react";

import Modal from "./Modal";
import AdminUsers from "./AdminUsers";
import ActivityLog from "./ActivityLog";
import WeeklyReport from "./WeeklyReport";
import LunchCutover from "./LunchCutover";
import MissedReflections from "./MissedReflections";
import InsightsPanel from "./InsightsPanel";
import { AttendanceLegend } from "./InsightLegend";
import StudentProfile, { followUpIds } from "./StudentProfile";
import SchoolDatePicker from "./SchoolDatePicker";
import { nextReflectionDay, nextSchoolDay, reflectionDayClosure, schoolDayClosure } from "@/app/lib/school-calendar";
import { casablancaClock } from "@/app/lib/weekly-report";

type Student = { id: string; name: string; grade: string; className: string; active?: boolean; toddleId?: string | null };
type Slot = "morning" | "lunch";
type Attendance = "pending" | "present" | "absent";
type Assignment = {
  id: string;
  studentId: string;
  date: string;
  slot: Slot;
  reason?: string;
  assignedBy?: string;
  status: Attendance;
  createdAt?: string;
  attendanceRecordedBy?: string | null;
  attendanceRecordedAt?: string | null;
  rescheduledFromId?: string | null;
  rescheduledToId?: string | null;
  rescheduledToIds?: string[];
  canCorrectAttendance?: boolean;
};
type AppData = { students: Student[]; assignments: Assignment[]; meta?: { rosterSource?: string; rosterImportedAt?: string }; user?: { name?: string; email?: string; role?: "admin" | "teacher" | "moderator" } };
type View = "sessions" | "directory" | "history" | "users" | "missed" | "insights" | "teacher-insights" | "activity" | "weekly-report";
type ModalType = "reflection" | "student" | "edit-student" | "import" | "help" | null;
type ImportStudent = { name: string; grade: string; className: string; toddleId?: string };
const slotLabels: Record<Slot, string> = { morning: "Morning break", lunch: "Lunch break" };
const reflectionLocation = "Music Room, canteen floor";
const unconfirmedBehaviourSteps = { chance: false, choice: false, consequence: false };
const behaviourStepLabels = [
  { step: "chance", label: "Chance" },
  { step: "choice", label: "Choice" },
  { step: "consequence", label: "Consequence" },
] as const;
const adminViews: View[] = ["insights", "teacher-insights", "users", "activity", "weekly-report", "missed"];
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
function compareGrades(a: string, b: string): number {
  function order(value: string): number | null {
    const normalized = value.normalize("NFKC").toLowerCase().replace(/[\s-]+/g, "");
    if (normalized === "prenursery") return 0;
    if (normalized === "nursery") return 1;
    if (normalized === "reception") return 2;
    const numbered = normalized.match(/^(?:year|grade|form)(\d+)$/);
    return numbered ? Number(numbered[1]) + 3 : null;
  }
  const first = order(a);
  const second = order(b);
  if (first !== null && second !== null) return first - second || collator.compare(a, b);
  if (first !== null) return -1;
  if (second !== null) return 1;
  return collator.compare(a, b);
}

function todayISO() { return casablancaClock(new Date()).date; }
function defaultReflectionDate() { return nextReflectionDay(todayISO(), true) || ""; }
function normalizedReason(value: string) { return value.normalize("NFKC").replace(/\s+/g, " ").trim(); }
function hasReason(value: string) { return !!normalizedReason(value).replace(/[\p{White_Space}\p{Cf}]/gu, ""); }
function formatDate(date: string, options?: Intl.DateTimeFormatOptions) { return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", options || { weekday: "long", day: "numeric", month: "long", year: "numeric" }); }
class WorkspaceLoadError extends Error { constructor(message: string, readonly status: number) { super(message); this.name = "WorkspaceLoadError"; } }
async function loadWorkspace(signal?: AbortSignal): Promise<AppData> { const response = await fetch("/api/data", { cache: "no-store", signal }); const json = await response.json() as AppData & { error?: string }; if (!response.ok) throw new WorkspaceLoadError(json.error || "Could not load the school workspace.", response.status); return { ...json, students: json.students || [], assignments: json.assignments || [] }; }
function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join("").toUpperCase(); }
function csvCell(value: unknown) { let s = String(value ?? ""); if (/^[\s]*[=+@-]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; }
function downloadCsv(name: string, rows: unknown[][]) { const blob = new Blob(["\uFEFF" + rows.map(r => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8;" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
function directoryCsvRows(students: Student[]): unknown[][] {
  const includeIds = students.some(student => student.toddleId);
  return [["Name", "Grade", "Class", ...(includeIds ? ["ToddleID"] : [])], ...students.map(student => [student.name, student.grade, student.className, ...(includeIds ? [student.toddleId || ""] : [])])];
}
function parseCsv(text: string): ImportStudent[] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.split(/\r?\n/)[0] || "";
  const delimiter = firstLine.includes(";") && !firstLine.includes(",") ? ";" : firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  for (let i = 0; i < clean.length; i++) { const c = clean[i]; if (c === '"') { if (quoted && clean[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (c === delimiter && !quoted) { row.push(cell.trim()); cell = ""; } else if ((c === "\n" || c === "\r") && !quoted) { if (c === "\r" && clean[i + 1] === "\n") i++; row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; } else cell += c; }
  if (quoted) throw new Error("One of the CSV values has an unclosed quotation mark.");
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error("Include a header row and at least one student.");
  const headers = rows[0].map(h => h.toLowerCase().replace(/[ _-]/g, ""));
  const field = (names: string[]) => headers.findIndex(h => names.includes(h));
  const nameIndex = field(["name", "studentname", "fullname", "student", "pupilname"]); const first = field(["firstname", "givenname"]); const last = field(["lastname", "surname", "familyname"]);
  const gradeIndex = field(["grade", "year", "yeargroup", "level", "niveau"]); const classIndex = field(["class", "classname", "homeroom", "section", "classe"]);
  const toddleIndex = field(["toddleid"]);
  if ((nameIndex < 0 && first < 0) || gradeIndex < 0 || classIndex < 0) throw new Error("Use the headers Name, Grade and Class (or First name, Last name, Grade and Class).");
  return rows.slice(1).map((r, index) => { const student: ImportStudent = { name: nameIndex >= 0 ? r[nameIndex] || "" : [r[first], r[last]].filter(Boolean).join(" "), grade: r[gradeIndex] || "", className: r[classIndex] || "", ...(toddleIndex >= 0 && r[toddleIndex] ? { toddleId: r[toddleIndex] } : {}) }; if (!student.name || !student.grade || !student.className) throw new Error(`Row ${index + 2} is missing a name, grade or class.`); return student; });
}


export default function ReflectionWorkspace({ portal = "default" }: { portal?: "default" | "admin" | "teacher" } = {}) {
  const [data, setData] = useState<AppData>({ students: [], assignments: [] });
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(""); const [accessError, setAccessError] = useState<{ status: number; message: string } | null>(null);
  const [requestedView, setView] = useState<View>("sessions"); const [date, setDate] = useState(todayISO); const [historySlot, setHistorySlot] = useState<"all" | Slot>("all");
  const [query, setQuery] = useState(""); const [grade, setGrade] = useState(""); const [classFilter, setClassFilter] = useState(""); const [statusFilter, setStatusFilter] = useState(""); const [historyDate, setHistoryDate] = useState("");
  const [modal, setModal] = useState<ModalType>(null); const [mobileNav, setMobileNav] = useState(false); const [toast, setToast] = useState(""); const [saving, setSaving] = useState(false); const [formError, setFormError] = useState(""); const [updating, setUpdating] = useState<string[]>([]); const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]); const [studentQuery, setStudentQuery] = useState(""); const [studentGrade, setStudentGrade] = useState(""); const [studentClass, setStudentClass] = useState(""); const [reflectionDate, setReflectionDate] = useState(defaultReflectionDate); const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);
  const [behaviourSteps, setBehaviourSteps] = useState(unconfirmedBehaviourSteps);
  const behaviourStepsConfirmed = behaviourSteps.chance && behaviourSteps.choice && behaviourSteps.consequence;
  const [dateChoice, setDateChoice] = useState<"today" | "custom">(() => reflectionDayClosure(todayISO()) ? "custom" : "today"); const [bookingRefreshing, setBookingRefreshing] = useState(false); const [bookingLoadError, setBookingLoadError] = useState("");
  const [profileStudentId, setProfileStudentId] = useState<string | null>(null); const [rescheduleId, setRescheduleId] = useState<string | null>(null); const [rescheduleDate, setRescheduleDate] = useState(todayISO);
  const [newName, setNewName] = useState(""); const [newGrade, setNewGrade] = useState(""); const [newClass, setNewClass] = useState(""); const [csvText, setCsvText] = useState(""); const [importPreview, setImportPreview] = useState<ImportStudent[]>([]); const [fileName, setFileName] = useState("");
  const [showArchived, setShowArchived] = useState(false); const [editingStudent, setEditingStudent] = useState<Student | null>(null); const [studentBusyIds, setStudentBusyIds] = useState<string[]>([]);
  const [pagination, setPagination] = useState({ key: "", page: 1 });
  function handleWorkspaceError(error: unknown) { const message = error instanceof Error ? error.message : "Could not load the school workspace."; setLoadError(message); if (error instanceof WorkspaceLoadError && (error.status === 401 || error.status === 403)) { setAccessError({ status: error.status, message }); setData({ students: [], assignments: [] }); setView("sessions"); setModal(null); setDeleteId(null); setSelectedStudents([]); setEditingStudent(null); setCsvText(""); setImportPreview([]); setQuery(""); setStudentQuery(""); setReason(""); setNewName(""); setProfileStudentId(null); setRescheduleId(null); } }
  function receiveWorkspace(result: AppData) { setData(result); setLoadError(""); setAccessError(null); }
  async function refresh(initial = false) { if (initial) setLoading(true); setLoadError(""); try { receiveWorkspace(await loadWorkspace()); } catch (error) { handleWorkspaceError(error); } finally { setLoading(false); } }
  useEffect(() => { const controller = new AbortController(); void loadWorkspace(controller.signal).then(result => { if (!controller.signal.aborted) receiveWorkspace(result); }).catch(error => { if (!controller.signal.aborted) handleWorkspaceError(error); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, []);
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(""), 5000); return () => clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    const controller = new AbortController();
    const sync = () => { if (document.visibilityState !== "visible") return; void loadWorkspace(controller.signal).then(result => { if (!controller.signal.aborted) receiveWorkspace(result); }).catch(error => { if (!controller.signal.aborted) handleWorkspaceError(error); }); };
    const timer = setInterval(sync, 15000);
    window.addEventListener("focus", sync);
    return () => { clearInterval(timer); window.removeEventListener("focus", sync); controller.abort(); };
  }, []);
  const isStaffAdmin = data.user?.role === "admin";
  const isAdmin = isStaffAdmin && portal !== "teacher";
  const canSwitchViews = isStaffAdmin || data.user?.role === "moderator";
  const view = !isAdmin && adminViews.includes(requestedView) ? "sessions" : requestedView;
  const activeStudents = useMemo(() => data.students.filter(student => student.active !== false), [data.students]);
  const directoryStudents = useMemo(() => isAdmin && showArchived ? data.students : activeStudents, [data.students, activeStudents, isAdmin, showArchived]);
  const studentMap = useMemo(() => new Map(data.students.map(s => [s.id, s])), [data.students]);
  const assignmentsById = useMemo(() => new Map(data.assignments.map(assignment => [assignment.id, assignment])), [data.assignments]);
  const unbookedAbsences = useMemo(() => data.assignments.filter(assignment => {
    const student = studentMap.get(assignment.studentId);
    return student && student.active !== false && assignment.status === "absent" && followUpIds(assignment).length === 0;
  }), [data.assignments, studentMap]);
  const studentDisplayNames = useMemo(() => {
    const groups = new Map<string, Student[]>();
    for (const student of data.students) {
      const key = JSON.stringify([student.name, student.grade, student.className].map(value => value.normalize("NFKC").trim().toLowerCase()));
      groups.set(key, [...(groups.get(key) || []), student]);
    }
    const labels = new Map<string, string>();
    for (const group of groups.values()) for (const student of group) {
      if (group.length < 2 || !student.toddleId) { labels.set(student.id, student.name); continue; }
      let length = Math.min(6, student.toddleId.length);
      while (length < student.toddleId.length && group.some(other => other.id !== student.id && other.toddleId?.slice(-length) === student.toddleId!.slice(-length))) length++;
      labels.set(student.id, `${student.name} · Ref ${student.toddleId.slice(-length)}`);
    }
    return labels;
  }, [data.students]);
  const displayStudents = useMemo(() => data.students.map(student => ({ ...student, name: studentDisplayNames.get(student.id) || student.name })), [data.students, studentDisplayNames]);
  function studentLabel(student?: Student) { return student ? studentDisplayNames.get(student.id) || student.name : "Student unavailable"; }
  const grades = useMemo(() => [...new Set(data.students.map(s => s.grade))].sort(compareGrades), [data.students]);
  const classes = useMemo(() => [...new Set(data.students.filter(s => !grade || s.grade === grade).map(s => s.className))].sort(collator.compare), [data.students, grade]);
  const lunchAssignments = data.assignments.filter(assignment => assignment.date === date && assignment.slot === "lunch");
  const pendingMorningCount = data.assignments.filter(assignment => assignment.slot === "morning" && assignment.status === "pending").length;
  const reflectionClosure = reflectionDate ? reflectionDayClosure(reflectionDate) : "Choose an available reflection date.";
  const replacementClosure = rescheduleDate ? reflectionDayClosure(rescheduleDate) : "Choose an available reflection date.";
  const todayClosure = reflectionDayClosure(todayISO());
  const overviewClosure = schoolDayClosure(date);
  const previousSchoolDate = nextSchoolDay(date, -1);
  const followingSchoolDate = nextSchoolDay(date, 1);
  const lunchAttendance = { present: 0, absent: 0, pending: 0 };
  for (const assignment of lunchAssignments) lunchAttendance[assignment.status]++;
  const filteredStudents = useMemo(() => directoryStudents.filter(s => (!query || `${s.name} ${s.grade} ${s.className}`.toLowerCase().includes(query.toLowerCase())) && (!grade || s.grade === grade) && (!classFilter || s.className === classFilter)).sort((a, b) => compareGrades(a.grade, b.grade) || collator.compare(a.className, b.className) || collator.compare(a.name, b.name)), [directoryStudents, query, grade, classFilter]);
  const studentGroups = useMemo(() => { const groups = new Map<string, { grade: string; className: string; students: Student[] }>(); for (const student of filteredStudents) { const key = `${student.grade}::${student.className}`; if (!groups.has(key)) groups.set(key, { grade: student.grade, className: student.className, students: [] }); groups.get(key)!.students.push(student); } return [...groups.values()]; }, [filteredStudents]);
  const filteredAssignments = useMemo(() => data.assignments.filter(assignment => {
    const student = studentMap.get(assignment.studentId);
    const inView = view === "history"
      ? (!historyDate || assignment.date === historyDate) && (historySlot === "all" || assignment.slot === historySlot)
      : assignment.date === date && assignment.slot === "lunch";
    const searchText = `${student?.name || ""} ${student?.grade || ""} ${student?.className || ""} ${assignment.reason || ""} ${assignment.assignedBy || ""}`;
    return inView
      && (!query || searchText.toLowerCase().includes(query.toLowerCase()))
      && (!grade || student?.grade === grade)
      && (!classFilter || student?.className === classFilter)
      && (!statusFilter || assignment.status === statusFilter);
  }).sort((a, b) => {
    if (view === "history" && a.date !== b.date) return b.date.localeCompare(a.date);
    const firstStudent = studentMap.get(a.studentId);
    const secondStudent = studentMap.get(b.studentId);
    return compareGrades(firstStudent?.grade || "", secondStudent?.grade || "")
      || collator.compare(firstStudent?.className || "", secondStudent?.className || "")
      || collator.compare(firstStudent?.name || "", secondStudent?.name || "")
      || a.slot.localeCompare(b.slot);
  }), [data.assignments, studentMap, view, historyDate, date, historySlot, query, grade, classFilter, statusFilter]);
  const pickerStudents = activeStudents.filter(s => (!studentQuery || `${s.name} ${s.grade} ${s.className}`.toLowerCase().includes(studentQuery.toLowerCase())) && (!studentGrade || s.grade === studentGrade) && (!studentClass || s.className === studentClass)).sort((a, b) => compareGrades(a.grade, b.grade) || collator.compare(a.className, b.className) || collator.compare(a.name, b.name));
  const bookedForSelection = data.assignments.filter(assignment =>
    assignment.slot === "lunch" && assignment.date === reflectionDate && selectedStudents.includes(assignment.studentId),
  );
  const hasBookingConflict = bookedForSelection.length > 0;
  const profileStudent = profileStudentId ? studentMap.get(profileStudentId) : undefined;
  const rescheduleSource = rescheduleId ? data.assignments.find(assignment => assignment.id === rescheduleId) : undefined;
  const rescheduleStudent = rescheduleSource ? studentMap.get(rescheduleSource.studentId) : undefined;
  const rescheduleHasFollowUps = rescheduleSource ? followUpIds(rescheduleSource).length > 0 : false;
  const rescheduleBlocked = rescheduleSource && data.assignments.some(assignment =>
    assignment.slot === "lunch" && assignment.studentId === rescheduleSource.studentId && assignment.date === rescheduleDate,
  );
  const pageSize = 12; const pageCount = Math.max(1, Math.ceil(filteredAssignments.length / pageSize)); const filterKey = JSON.stringify([query, grade, classFilter, historySlot, date, statusFilter, historyDate, view]); const page = Math.min(pageCount, pagination.key === filterKey ? pagination.page : 1);
  function changePage(next: number) { setPagination({ key: filterKey, page: Math.max(1, Math.min(pageCount, next)) }); }
  function changeView(next: View) { if (!isAdmin && adminViews.includes(next)) return; setView(next); setQuery(""); setGrade(""); setClassFilter(""); setStatusFilter(""); setHistorySlot("all"); setHistoryDate(""); setMobileNav(false); }
  function openModal(next: ModalType, student?: Student) { if ((next === "student" || next === "edit-student" || next === "import") && !isAdmin) return; setFormError(""); if (next === "reflection") { setSelectedStudents(student ? [student.id] : []); setStudentQuery(""); setStudentGrade(""); setStudentClass(""); setReflectionDate(defaultReflectionDate()); setDateChoice(todayClosure ? "custom" : "today"); void refreshBookings(); setReason(""); setReasonTouched(false); setBehaviourSteps(unconfirmedBehaviourSteps); } if (next === "student" || next === "edit-student") { setEditingStudent(next === "edit-student" ? student || null : null); setNewName(student?.name || ""); setNewGrade(student?.grade || ""); setNewClass(student?.className || ""); } if (next === "import") { setCsvText(""); setImportPreview([]); setFileName(""); } setModal(next); }
  async function refreshBookings() { setBookingRefreshing(true); setBookingLoadError(""); try { receiveWorkspace(await loadWorkspace()); } catch (error) { if (error instanceof WorkspaceLoadError && (error.status === 401 || error.status === 403)) handleWorkspaceError(error); else setBookingLoadError(error instanceof Error ? error.message : "Could not check the latest bookings."); } finally { setBookingRefreshing(false); } }
  function openReschedule(assignment: { id: string; date: string }) {
    if (!isAdmin) return;
    const today = todayISO();
    const pastSession = assignment.date < today;
    setRescheduleId(assignment.id);
    setRescheduleDate(nextReflectionDay(pastSession ? today : assignment.date, pastSession) || "");
    setFormError("");
    void refreshBookings();
  }

  async function saveReschedule(event: FormEvent) {
    event.preventDefault();
    if (!isAdmin) return;
    if (replacementClosure) { setFormError(replacementClosure); return; }
    if (!rescheduleSource || rescheduleSource.status !== "absent" || rescheduleHasFollowUps
      || rescheduleBlocked || rescheduleDate < rescheduleSource.date || rescheduleStudent?.active === false) {
      setFormError("Choose an available lunch on or after the original reflection date.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      await api(`/api/assignments/${encodeURIComponent(rescheduleSource.id)}/reschedule`, "POST", { date: rescheduleDate, slot: "lunch" });
      await refresh();
      setRescheduleId(null);
      setToast(`Follow-up lunch booked for ${formatDate(rescheduleDate, { weekday: "long", day: "numeric", month: "long" })}.`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not reschedule this reflection.");
      await refresh();
    } finally {
      setSaving(false);
    }
  }
  function closeModal() { if (!saving) { setModal(null); setFormError(""); } }
  async function api(path: string, method: string, body?: unknown) {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({})) as {
      error?: string;
      created?: number;
      skipped?: number;
      imported?: number;
      followUp?: { id: string; date: string } | null;
      followUps?: { id: string; date: string }[];
      followUpUnavailable?: "archived" | "calendar" | null;
      followUpCancelled?: boolean;
    };
    if (!response.ok) {
      const error = new WorkspaceLoadError(result.error || "Something went wrong. Please try again.", response.status);
      if (response.status === 401 || response.status === 403) handleWorkspaceError(error);
      throw error;
    }
    return result;
  }
  async function saveReflection(event: FormEvent) {
    event.preventDefault();
    setReasonTouched(true);
    if (!hasReason(reason)) { setFormError("Enter a reason for this reflection."); return; }
    if (!behaviourStepsConfirmed) { setFormError("Confirm all three behaviour steps."); return; }
    if (reflectionClosure) { setFormError(reflectionClosure); return; }
    if (!selectedStudents.length || hasBookingConflict || bookingRefreshing || bookingLoadError) {
      setFormError("Choose a date when every selected student is available at lunch.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const latest = await loadWorkspace();
      receiveWorkspace(latest);
      const conflicts = latest.assignments.filter(assignment =>
        assignment.slot === "lunch" && assignment.date === reflectionDate && selectedStudents.includes(assignment.studentId),
      );
      if (conflicts.length) {
        const latestNames = new Map(latest.students.map(student => [student.id, student.name]));
        const names = conflicts.map(assignment => latestNames.get(assignment.studentId) || "Student").join(", ");
        throw new Error(`Lunch already booked for ${names}. Choose another school day or adjust the student selection.`);
      }
      const unavailable = selectedStudents.some(id => !latest.students.some(student => student.id === id && student.active !== false));
      if (unavailable) throw new Error("One or more selected students are no longer active. Update the student selection.");
      const result = await api("/api/assignments", "POST", {
        studentIds: selectedStudents,
        date: reflectionDate,
        slots: ["lunch"],
        reason: normalizedReason(reason),
        behaviourSteps,
      });
      await refresh();
      if (result.skipped) {
        setFormError(`${result.created || 0} sessions were added. ${result.skipped} were already booked. Review the updated bookings before continuing.`);
        return;
      }
      setModal(null);
      const created = result.created ?? selectedStudents.length;
      setToast(`${created} reflection session${created === 1 ? "" : "s"} added.`);
    } catch (error) {
      if (error instanceof WorkspaceLoadError && (error.status === 401 || error.status === 403)) handleWorkspaceError(error);
      setFormError(error instanceof Error ? error.message : "Could not add reflection.");
      if (error instanceof WorkspaceLoadError && error.status === 409) await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function saveStudents(students: ImportStudent[], source: string) { setSaving(true); setFormError(""); try { const result = await api("/api/students", "POST", { students, source }); await refresh(); setModal(null); setToast(`${result.imported ?? result.created ?? students.length} student${students.length === 1 ? "" : "s"} saved to the directory.`); } catch (error) { setFormError(error instanceof Error ? error.message : "Could not save students."); } finally { setSaving(false); } }
  async function saveStudentForm(event: FormEvent) { event.preventDefault(); const student = { name: newName.trim(), grade: newGrade.trim(), className: newClass.trim() }; if (!editingStudent) { await saveStudents([student], "Manual entry"); return; } setSaving(true); setFormError(""); try { await api(`/api/students/${encodeURIComponent(editingStudent.id)}`, "PATCH", student); await refresh(); setModal(null); setToast("Student details updated."); } catch (error) { setFormError(error instanceof Error ? error.message : "Could not update student."); } finally { setSaving(false); } }
  async function toggleStudent(student: Student) { if (!isAdmin) return; setStudentBusyIds(ids => [...ids, student.id]); try { await api(`/api/students/${encodeURIComponent(student.id)}`, student.active === false ? "PATCH" : "DELETE", student.active === false ? { active: true } : undefined); await refresh(); setToast(student.active === false ? "Student restored to the active directory." : "Student archived. Previous reflection records are retained."); } catch (error) { setToast(error instanceof Error ? error.message : "Could not update this student."); } finally { setStudentBusyIds(ids => ids.filter(id => id !== student.id)); } }
  async function markAttendance(id: string, status: Attendance) {
    setUpdating(ids => [...ids, id]);
    try {
      const result = await api(`/api/assignments/${encodeURIComponent(id)}`, "PATCH", { status });
      await refresh();
      const followUps = result.followUps ?? (result.followUp ? [result.followUp] : []);
      if (status === "absent" && followUps.length > 0) {
        const lunchDates = followUps.map(booking => formatDate(booking.date, { weekday: "long", day: "numeric", month: "long" }));
        setToast(`Absence recorded. Follow-up ${lunchDates.length === 1 ? "lunch booked" : "lunches booked"} for ${lunchDates.join(" and ")}.`);
      } else if (result.followUpUnavailable === "archived") {
        setToast("Absence recorded. An admin can restore the student to book a follow-up.");
      } else if (result.followUpUnavailable === "calendar") {
        setToast(isAdmin
          ? "Absence recorded. Couldn’t find two available lunch dates. Check Follow-up needed."
          : "Absence recorded. Couldn’t find two available lunch dates. Ask an admin to review.");
      } else {
        const original = assignmentsById.get(id);
        const bookingLabel = original && followUpIds(original).length === 1 ? "booking" : "bookings";
        setToast(result.followUpCancelled ? `Attendance corrected. Pending lunch ${bookingLabel} cancelled.` : "Attendance updated.");
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not update attendance.");
      if (error instanceof WorkspaceLoadError && error.status === 409) await refresh();
    } finally {
      setUpdating(ids => ids.filter(value => value !== id));
    }
  }
  async function removeAssignment() { if (!deleteId) return; setSaving(true); try { await api(`/api/assignments/${deleteId}`, "DELETE"); setData(old => ({ ...old, assignments: old.assignments.filter(a => a.id !== deleteId) })); setDeleteId(null); setToast("Reflection removed from the register."); } catch (error) { setToast(error instanceof Error ? error.message : "Could not remove reflection."); } finally { setSaving(false); } }
  function exportRegister() { downloadCsv(`reflection-room-${view === "history" ? "history" : date}.csv`, [["Date", "Student", "Grade", "Class", "Session", "Attendance", "Reason", "Assigned by", "Attendance recorded by", "Attendance recorded at"], ...filteredAssignments.map(a => { const s = studentMap.get(a.studentId); return [a.date, s?.name || "Student unavailable", s?.grade, s?.className, slotLabels[a.slot], a.status, a.reason, a.assignedBy, a.attendanceRecordedBy, a.attendanceRecordedAt]; })]); setToast("Register exported."); }
  function previewImport() { try { setImportPreview(parseCsv(csvText)); setFormError(""); } catch (error) { setImportPreview([]); setFormError(error instanceof Error ? error.message : "Could not read CSV."); } }
  const title = view === "sessions" ? "Reflection Room" : view === "directory" ? "Student directory" : view === "users" ? "User management" : view === "activity" ? "Activity log" : view === "weekly-report" ? "Weekly report" : view === "missed" ? "Follow-up needed" : view === "insights" ? "Student insights" : view === "teacher-insights" ? "Teacher insights" : "Reflection history";
  const subtitle = view === "sessions" ? "See who’s expected at lunch and record attendance." : view === "directory" ? "Every student, organised by grade and class." : view === "users" ? "The right access for every member of your school team." : view === "activity" ? "See who changed what and when." : view === "weekly-report" ? "Review the weekly summary before approving email delivery." : view === "missed" ? "Choose lunch dates for absences awaiting a follow-up." : view === "insights" ? "Recorded reflection absences by student and class." : view === "teacher-insights" ? "Reflection assignments across your school team." : "Review previous sessions and keep track of attendance.";
  const navItems = [
    { id: "sessions" as View, label: "Daily overview", icon: LayoutDashboard },
    { id: "directory" as View, label: "Student directory", icon: Users },
    { id: "history" as View, label: "Reflection history", icon: History },
    ...(isAdmin ? [
      { id: "insights" as View, label: "Student insights", icon: ChartNoAxesColumnIncreasing },
      { id: "teacher-insights" as View, label: "Teacher insights", icon: GraduationCap },
      ...(unbookedAbsences.length ? [{ id: "missed" as View, label: "Follow-up needed", icon: CalendarClock }] : []),
    ] : []),
  ];

  return <div className="app-shell">
    {mobileNav && <div className="mobile-scrim" onClick={() => setMobileNav(false)}/>}
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); changeView("sessions"); }} aria-label="Reflection Room home"><div className="brand-symbol"><BookOpen size={23} strokeWidth={1.6}/><span/></div><div><strong>Reflection<span>Room</span></strong><small>SPACE TO RESET</small></div></a>
      <div className="workspace-label">SCHOOL WORKSPACE</div>
      <nav aria-label="Main navigation">{navItems.map(item => <button key={item.id} className={`nav-link ${view === item.id ? "active" : ""}`} onClick={() => changeView(item.id)}><item.icon size={19}/><span>{item.label}</span>{item.id === "sessions" && <span className="nav-dot"/>}</button>)}</nav>
      {isAdmin && <div className="admin-navigation"><div className="workspace-label">ADMINISTRATION</div><button className={`nav-link ${view === "users" ? "active" : ""}`} onClick={() => changeView("users")}><UserRoundCog size={19}/><span>User management</span></button><button className={`nav-link ${view === "activity" ? "active" : ""}`} onClick={() => changeView("activity")}><ListChecks size={19}/><span>Activity log</span></button><button className={`nav-link ${view === "weekly-report" ? "active" : ""}`} onClick={() => changeView("weekly-report")}><CalendarDays size={19}/><span>Weekly report</span></button><button className="nav-link" onClick={() => changeView("directory")}><ShieldCheck size={19}/><span>Manage students</span></button></div>}
      <div className="sidebar-note"><div className="note-orbit"><Sparkles size={19}/></div><h3>Pause. Reflect. Grow.</h3><p>A shared space for positive choices and fresh starts.</p><div className="note-line"/></div>
      <div className="sidebar-bottom"><button className="help-link" onClick={() => openModal("help")}><CircleHelp size={18}/> Help & guidance <ArrowUpRight size={15}/></button><div className="school-profile"><div className="school-avatar"><img src="/school-logo.png" width={47} height={47} alt="London Academy school logo"/></div><div><strong>London Academy</strong><span>Bouskoura campus</span></div><ShieldCheck size={16}/></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={22}/></button><img className="topbar-logo" src="/school-logo.png" width={29} height={29} alt="London Academy"/><span className="topbar-school">London Academy</span><span className="topbar-divider">/</span><span>Student wellbeing</span></div><div className="topbar-right">{data.user?.role && <span className={`role-badge ${data.user.role}`}><ShieldCheck size={12}/>{isStaffAdmin ? "Admin" : data.user.role === "moderator" ? "Moderator" : "Teacher"}</span>}<span className="topbar-rule"/><div className="user-avatar" title={data.user?.name || "School staff"}>{data.user?.name ? initials(data.user.name) : <GraduationCap size={18}/>}</div><div className="user-info"><strong>{data.user?.name || "School staff"}</strong><span>{data.user?.email || "Reflection Room"}</span></div><form method="POST" action="/auth/logout" target="_top"><button className="text-button signout-link" type="submit">Sign out</button></form></div></header>
      <main className="main-content">
        {canSwitchViews && !accessError && <div className="workspace-view-controls no-print"><nav className="workspace-view-switch" aria-label="Workspace view">{isStaffAdmin && <a href="/admin" aria-current={isAdmin ? "page" : undefined}><ShieldCheck size={14} aria-hidden="true"/>Admin view</a>}<a href="/teacher" aria-current={!isAdmin ? "page" : undefined}><GraduationCap size={15} aria-hidden="true"/>Teacher view</a><a href="/moderator"><ChartNoAxesColumnIncreasing size={14} aria-hidden="true"/>Moderator view</a></nav></div>}
        {accessError ? <section className="access-denied-panel"><span className="access-denied-icon"><ShieldCheck size={30}/></span><div className="page-eyebrow">SCHOOL STAFF WORKSPACE</div><h1>{accessError.status === 401 ? "Sign in to Reflection Room" : "School access required"}</h1><p>{accessError.message}</p><p className="access-guidance">Staff sign in with an authorised school Google Workspace account. An administrator manages staff access.</p><div>{accessError.status === 401 && <a className="button primary" href={portal === "admin" ? "/admin" : portal === "teacher" ? "/teacher" : "/"} target="_top">Sign in <ArrowUpRight size={15}/></a>}<button className="button secondary" disabled={loading} onClick={() => refresh(true)}>{loading ? <LoaderCircle className="spin" size={15}/> : <RotateCcw size={15}/>}Check access again</button></div></section> : <>
        <div className="page-heading"><div><div className="page-eyebrow"><span/>STUDENT WELLBEING</div><h1>{title}<span className="heading-dot">.</span></h1><p>{subtitle}</p></div><div className="heading-actions">{view === "users" || view === "activity" || view === "insights" || view === "teacher-insights" || view === "missed" ? null : view === "directory" ? isAdmin ? <><button className="button secondary" onClick={() => openModal("import")}><Upload size={16}/> Import students</button><button className="button primary" onClick={() => openModal("student")}><Plus size={18}/> Add student</button></> : null : <button className="button primary" onClick={() => openModal("reflection")}><Plus size={18}/> Add reflection</button>}</div></div>
        {loadError && <div className="error-banner" role="alert"><div><strong>We couldn’t load the workspace.</strong><span>{loadError}</span></div><button className="button secondary small" onClick={() => refresh(true)}>Try again</button></div>}
        {view === "sessions" && <>
          <div className="date-toolbar"><div className="date-current"><div className="calendar-icon"><CalendarDays size={20}/></div><div><span className="date-overline">{date === todayISO() ? "TODAY’S OVERVIEW" : "DAILY OVERVIEW"}</span><label className="date-label" htmlFor="overview-date">{formatDate(date)}<ChevronDown size={15}/></label><input id="overview-date" className="date-native" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Choose overview date"/></div></div><div className="date-controls">{date !== todayISO() && <button className="text-button today-button" onClick={() => setDate(todayISO())}>Today</button>}<button className="icon-button" disabled={!previousSchoolDate} onClick={() => previousSchoolDate && setDate(previousSchoolDate)} aria-label="Previous school day"><ChevronLeft size={18}/></button><span className="date-control-rule"/><button className="icon-button" disabled={!followingSchoolDate} onClick={() => followingSchoolDate && setDate(followingSchoolDate)} aria-label="Next school day"><ChevronRight size={18}/></button></div></div>
          {overviewClosure && <div className="school-day-notice"><CalendarDays size={18} aria-hidden="true"/><p><strong>{overviewClosure}</strong> Existing records can still be reviewed. New reflections need a school day.</p></div>}
          {isAdmin && pendingMorningCount > 0 && (
            <LunchCutover
              pendingCount={pendingMorningCount}
              onComplete={async moved => {
                await refresh();
                setToast(`${moved} ${moved === 1 ? "booking moved" : "bookings moved"} to lunch.`);
              }}
              onAccessDenied={(status, message) => handleWorkspaceError(new WorkspaceLoadError(message, status))}
            />
          )}
          <section className="session-grid" aria-label="Lunch reflection">
            <article className="session-card lunch">
              <div className="session-top">
                <div className="session-icon"><Utensils size={22} strokeWidth={1.7} aria-hidden="true"/></div>
                <button className="session-add" onClick={() => openModal("reflection")} aria-label="Add lunch reflection"><Plus size={18}/></button>
              </div>
              <div className="session-card-body">
                <div>
                  <h2>Lunch break reflection</h2>
                  <p><MapPin size={16} aria-hidden="true"/> {reflectionLocation}</p>
                </div>
                <div className="session-number">{loading ? <span className="count-skeleton"/> : lunchAssignments.length}<span>expected</span></div>
              </div>
              <div className="session-card-footer">
                <div className="session-attendance">
                  <span><i className="dot green"/>{lunchAttendance.present} present</span>
                  <span><i className="dot rose"/>{lunchAttendance.absent} absent</span>
                  <span><i className="dot blue"/>{lunchAttendance.pending} pending</span>
                </div>
                <button className="session-view" onClick={() => {
                  setQuery("");
                  setGrade("");
                  setClassFilter("");
                  document.getElementById("session-register")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }} aria-label="View lunch register"><ArrowUpRight size={18}/></button>
              </div>
            </article>
          </section>
        </>}
        {view === "weekly-report" ? isAdmin ? <WeeklyReport onAccessDenied={(status, message) => handleWorkspaceError(new WorkspaceLoadError(message, status))}/> : <EmptyState icon={<ShieldCheck size={28}/>} title="Admin access required" text="Weekly reports are available to school admins."/> : view === "activity" ? isAdmin ? <ActivityLog onAccessDenied={(status, message) => handleWorkspaceError(new WorkspaceLoadError(message, status))}/> : <EmptyState icon={<ShieldCheck size={28}/>} title="Admin access required" text="Ask a school admin to view activity."/> : (view === "insights" || view === "teacher-insights") ? isAdmin ? <InsightsPanel view={view === "insights" ? "students" : "teachers"} onAccessDenied={(status, message) => handleWorkspaceError(new WorkspaceLoadError(message, status))}/> : <EmptyState icon={<ShieldCheck size={28}/>} title="Insights access required" text="Insights are available to admins and moderators."/> : view === "missed" ? <MissedReflections students={displayStudents} assignments={unbookedAbsences} onOpenStudent={setProfileStudentId} onReschedule={openReschedule}/> : view === "users" ? isAdmin ? <AdminUsers currentEmail={data.user?.email} onNotify={setToast} onAccessDenied={(status, message) => handleWorkspaceError(new WorkspaceLoadError(message, status))}/> : <EmptyState icon={<ShieldCheck size={28}/>} title="Admin access required" text="User management is available to school admins."/> : view === "directory" ? <section className="directory-section"><div className="directory-meta"><div className="directory-count"><span className="directory-count-icon"><Users size={21}/></span><div><strong>{loading ? "—" : activeStudents.length}</strong><span>active students in the directory</span></div></div><div className="roster-source"><span className="source-dot"/><span>{data.meta?.rosterSource || "School student directory"}{data.meta?.rosterImportedAt && <small>Updated {new Date(data.meta.rosterImportedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</small>}</span></div></div><div className="directory-controls"><div className="search-field"><Search size={17}/><input aria-label="Search student directory" placeholder="Search students by name…" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={14}/></button>}</div><select aria-label="Filter by grade" value={grade} onChange={e => { setGrade(e.target.value); setClassFilter(""); }}><option value="">All grades</option>{grades.map(g => <option key={g}>{g}</option>)}</select><select aria-label="Filter by class" value={classFilter} onChange={e => setClassFilter(e.target.value)}><option value="">All classes</option>{classes.map(c => <option key={c}>{c}</option>)}</select><button className="button secondary export-directory" disabled={!filteredStudents.length} onClick={() => downloadCsv("student-directory.csv", directoryCsvRows(filteredStudents))}><ArrowDownToLine size={16}/><span>Export</span></button></div>{isAdmin && <div className="archive-filter-row"><label><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)}/>Show archived students <span>{data.students.filter(student => student.active === false).length}</span></label><span>Archived students remain in previous reflection records.</span></div>}{loading ? <div className="loading-state"><LoaderCircle className="spin" size={25}/><p>Loading student directory…</p></div> : !directoryStudents.length ? <EmptyState icon={<Users size={29} strokeWidth={1.4}/>} title={isAdmin ? "Your student directory starts here" : "Your student directory is being prepared"} text={isAdmin ? "Bring in your school roster to find students by grade and class, and assign their reflection sessions." : "Your school admin can add the student roster. Students will then appear here by grade and class."} action={isAdmin ? <button className="button primary" onClick={() => openModal("import")}><Upload size={16}/> Import student list</button> : undefined} foot={isAdmin ? "CSV files with Name, Grade and Class are supported." : "A shared directory for authorised school staff."}/> : !studentGroups.length ? <EmptyState icon={<Search size={28}/>} title="No students found" text="Try a different name or adjust your grade and class filters." action={<button className="button secondary" onClick={() => { setQuery(""); setGrade(""); setClassFilter(""); }}>Clear filters</button>}/> : <><div className="directory-result-count">Showing {filteredStudents.length} student{filteredStudents.length === 1 ? "" : "s"} in {studentGroups.length} class{studentGroups.length === 1 ? "" : "es"}</div><div className="directory-groups">{studentGroups.map(group => <article className="class-card" key={`${group.grade}-${group.className}`}><header><div><span>{group.grade}</span><h3>{group.className}</h3></div><span className="class-student-count">{group.students.length} students</span></header><div className="class-students">{group.students.map((student, index) => <div className={`directory-student ${student.active === false ? "archived-student" : ""}`} key={student.id}><div className={`student-avatar avatar-${index % 4}`}>{initials(student.name)}</div><div><button className="student-name-link" onClick={() => setProfileStudentId(student.id)}>{studentLabel(student)}</button>{student.active === false && <small className="archived-label">Archived</small>}<span>{student.grade} <i/> {student.className}</span>{student.active !== false && <button className="student-send-button" onClick={() => openModal("reflection", student)}>Send to reflection <ArrowUpRight size={11}/></button>}</div><div className="student-actions">{isAdmin && <><button className="student-manage-button" aria-label={`Edit ${student.name}`} title="Edit student" onClick={() => openModal("edit-student", student)}><Pencil size={14}/></button><button className="student-manage-button" disabled={studentBusyIds.includes(student.id)} aria-label={`${student.active === false ? "Restore" : "Archive"} ${student.name}`} title={student.active === false ? "Restore student" : "Archive student"} onClick={() => toggleStudent(student)}>{studentBusyIds.includes(student.id) ? <LoaderCircle size={14} className="spin"/> : student.active === false ? <RotateCcw size={14}/> : <Archive size={14}/>}</button></>}</div></div>)}</div></article>)}</div></>}</section> : <section className="register-section" id="session-register"><div className="section-heading"><div className="section-title"><h2>{view === "history" ? "All reflections" : "Lunch register"}</h2><span className="count-badge">{filteredAssignments.length}</span></div><div className="register-actions"><button className="text-button" onClick={() => window.print()} disabled={!filteredAssignments.length}><Printer size={15}/><span>Print register</span></button><button className="text-button" onClick={exportRegister} disabled={!filteredAssignments.length}><ArrowDownToLine size={15}/><span>Export CSV</span></button></div></div><div className="register-colour-key"><AttendanceLegend/></div>{view === "history" && (
          <div className="register-tabs" role="tablist" aria-label="History session filter">
            {(["all", "morning", "lunch"] as const).map(slot => (
              <button key={slot} role="tab" aria-selected={historySlot === slot}
                className={historySlot === slot ? "selected" : ""} onClick={() => setHistorySlot(slot)}>
                {slot === "all" ? "All sessions" : slotLabels[slot]}
                <span>{data.assignments.filter(assignment => slot === "all" || assignment.slot === slot).length}</span>
              </button>
            ))}
          </div>
        )}<div className="register-filters"><div className="search-field"><Search size={17}/><input aria-label="Search session register" placeholder="Search students…" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={14}/></button>}</div><select aria-label="Filter register by grade" value={grade} onChange={e => { setGrade(e.target.value); setClassFilter(""); }}><option value="">All grades</option>{grades.map(g => <option key={g}>{g}</option>)}</select><select aria-label="Filter register by class" value={classFilter} onChange={e => setClassFilter(e.target.value)}><option value="">All classes</option>{classes.map(c => <option key={c}>{c}</option>)}</select><select aria-label="Filter attendance" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All attendance</option><option value="pending">Pending</option><option value="present">Present</option><option value="absent">Absent</option></select>{view === "history" && <div className="history-date-input"><input type="date" aria-label="Filter history by date" value={historyDate} onChange={e => setHistoryDate(e.target.value)}/>{historyDate && <button className="icon-button" onClick={() => setHistoryDate("")} aria-label="Clear date filter"><X size={14}/></button>}</div>}</div>{loading ? <div className="loading-state"><LoaderCircle className="spin" size={25}/><p>Preparing your register…</p></div> : !filteredAssignments.length ? <EmptyState icon={<ClipboardCheck size={30} strokeWidth={1.35}/>} title={query || grade || classFilter || statusFilter || historyDate ? "No reflections match your filters" : view === "history" ? "A fresh start for your records" : "A clear register. A fresh start."} text={query || grade || classFilter || statusFilter || historyDate ? "Try another search or update the filters to find a reflection." : view === "history" ? "Assigned reflections will appear here, along with their attendance records." : `No lunch reflections are scheduled for ${date === todayISO() ? "today" : "this day"}.`} action={query || grade || classFilter || statusFilter || historyDate ? <button className="button secondary" onClick={() => { setQuery(""); setGrade(""); setClassFilter(""); setStatusFilter(""); setHistoryDate(""); }}>Clear filters</button> : <button className="button secondary" onClick={() => openModal("reflection")}><Plus size={16}/> Add a reflection</button>} foot={data.students.length ? "Every small reflection is an opportunity to grow." : "Start by adding your student directory."}/> : <><div className="table-scroll"><table className="register-table"><thead><tr><th>Student</th><th>Grade / Class</th>{view === "history" && <th>Date</th>}<th>Session</th><th>Assigned by</th><th>Attendance</th><th className="reason-column">Reason</th><th className="no-print"><span className="sr-only">Actions</span></th></tr></thead><tbody>{filteredAssignments.map((assignment, index) => {
          const student = studentMap.get(assignment.studentId);
          const linkedIds = followUpIds(assignment);
          const followUpDates = linkedIds.flatMap(id => {
            const booking = assignmentsById.get(id);
            return booking ? [formatDate(booking.date, { weekday: "short", day: "numeric", month: "short" })] : [];
          });
          const hasFollowUps = linkedIds.length > 0;
          const followUpLabel = linkedIds.length === 1 ? "Follow-up" : "Follow-ups";
          const attendanceLocked = hasFollowUps && assignment.canCorrectAttendance !== true;
          const savingAttendance = updating.includes(assignment.id);
          return <tr key={assignment.id} className={index < (page - 1) * pageSize || index >= page * pageSize ? "off-page" : ""}>
            <td>
              <div className="table-student">
                <div className={`student-avatar avatar-${index % 4}`}>{initials(student?.name || "?")}</div>
                <button className="student-name-link" disabled={!student} onClick={() => student && setProfileStudentId(student.id)}>{studentLabel(student)}</button>
              </div>
            </td>
            <td><span className="grade-text">{student?.grade || "—"}</span><span className="table-class">{student?.className}</span></td>
            {view === "history" && <td className="table-date">{formatDate(assignment.date, { day: "numeric", month: "short", year: "numeric" })}</td>}
            <td>
              <span className={`slot-pill ${assignment.slot}`}>{assignment.slot === "morning" ? <Sun size={12}/> : <Utensils size={12}/>} {slotLabels[assignment.slot]}</span>
              {assignment.rescheduledFromId && <span className="reschedule-link-note">Follow-up session</span>}
              {hasFollowUps && <span className="reschedule-link-note">
                {followUpDates.length === linkedIds.length ? `${followUpLabel} on ${followUpDates.join(" and ")}` : `${followUpLabel} booked`}
              </span>}
            </td>
            <td className="assigned-cell">{assignment.assignedBy || "—"}</td>
            <td>
              <div className={`attendance-select ${assignment.status}`}>
                <span className="attendance-dot"/>
                <select
                  aria-label={`Attendance for ${student?.name || "student"}, ${slotLabels[assignment.slot]}`}
                  disabled={savingAttendance || attendanceLocked}
                  title={attendanceLocked ? "Review the linked bookings in Reflection history." : undefined}
                  value={assignment.status}
                  onChange={event => void markAttendance(assignment.id, event.target.value as Attendance)}
                >
                  <option value="pending">Pending</option><option value="present">Present</option><option value="absent">Absent</option>
                </select>
                {savingAttendance ? <LoaderCircle size={12} className="spin"/> : <ChevronDown size={12}/>}
              </div>
              {assignment.attendanceRecordedBy && <span className="attendance-provenance">Recorded by {assignment.attendanceRecordedBy}{assignment.attendanceRecordedAt && <> · {new Date(assignment.attendanceRecordedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</>}</span>}
            </td>
            <td className="reason-column reason-cell" title={assignment.reason}>{assignment.reason || "—"}</td>
            <td className="no-print">
              <button className="row-remove" disabled={hasFollowUps} title={hasFollowUps ? "Remove linked follow-up bookings before removing this original session." : "Remove reflection"} aria-label={`Remove reflection for ${student?.name || "student"}`} onClick={() => setDeleteId(assignment.id)}><Trash2 size={15}/></button>
            </td>
          </tr>;
        })}</tbody></table></div><div className="table-pagination"><span>Showing <strong>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filteredAssignments.length)}</strong> of {filteredAssignments.length} reflections</span><div><button className="icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => changePage(page - 1)}><ChevronLeft size={16}/></button><span>{page} / {pageCount}</span><button className="icon-button" aria-label="Next page" disabled={page >= pageCount} onClick={() => changePage(page + 1)}><ChevronRight size={16}/></button></div></div></>}</section>}
        <footer className="page-footer"><span><BookOpen size={14}/> A little reflection. A positive way forward.</span><span>London Academy <i/> Bouskoura</span></footer>
        </>}
      </main>
    </div>
    {toast && <div className="toast" role="status"><span><Check size={16}/></span>{toast}<button onClick={() => setToast("")} aria-label="Dismiss notification"><X size={15}/></button></div>}
    {modal === "reflection" && <Modal title="Send to reflection" subtitle={`Lunch break · ${reflectionLocation}`} onClose={closeModal} wide><form onSubmit={saveReflection}><div className="modal-body"><label className="form-label">Students <span>Required</span></label><div className="student-picker"><div className="search-field"><Search size={17}/><input placeholder="Search by student name…" aria-label="Search students to assign" value={studentQuery} onChange={e => setStudentQuery(e.target.value)}/></div><div className="picker-filters"><select aria-label="Choose grade" value={studentGrade} onChange={e => { setStudentGrade(e.target.value); setStudentClass(""); }}><option value="">All grades</option>{grades.map(g => <option key={g}>{g}</option>)}</select><select aria-label="Choose class" value={studentClass} onChange={e => setStudentClass(e.target.value)}><option value="">All classes</option>{[...new Set(activeStudents.filter(s => !studentGrade || s.grade === studentGrade).map(s => s.className))].sort(collator.compare).map(c => <option key={c}>{c}</option>)}</select></div><div className="picker-list">{!activeStudents.length ? <div className="picker-empty"><Users size={22}/><strong>Your directory is empty</strong><p>{isAdmin ? "Import your school roster or add a student first." : "Ask your school admin to add the student roster."}</p>{isAdmin && <button className="text-button" type="button" onClick={() => openModal("import")}><Upload size={14}/>Import student list</button>}</div> : !pickerStudents.length ? <p className="picker-empty">No students match your search.</p> : pickerStudents.map(s => <label className={`picker-student ${selectedStudents.includes(s.id) ? "is-selected" : ""}`} key={s.id}><input type="checkbox" checked={selectedStudents.includes(s.id)} onChange={e => setSelectedStudents(ids => e.target.checked ? [...ids, s.id] : ids.filter(id => id !== s.id))}/><div className="student-avatar">{initials(s.name)}</div><strong>{studentLabel(s)}</strong><span>{s.grade} <i/> {s.className}</span></label>)}</div><div className="picker-footer"><span>{selectedStudents.length} student{selectedStudents.length === 1 ? "" : "s"} selected</span>{selectedStudents.length > 0 && <button className="text-button" type="button" onClick={() => setSelectedStudents([])}>Clear selection</button>}</div></div><div className="form-field"><label className="form-label">Reflection date <span>Required</span></label><div className="date-choice-tabs" role="radiogroup" aria-label="Reflection date"><button type="button" role="radio" aria-checked={dateChoice === "today"} disabled={!!todayClosure} title={todayClosure || undefined} className={dateChoice === "today" ? "selected" : ""} onClick={() => { setDateChoice("today"); setReflectionDate(todayISO()); }}><CalendarDays size={14}/>Today <span>{formatDate(todayISO(), { day: "numeric", month: "short" })}</span></button><button type="button" role="radio" aria-checked={dateChoice === "custom"} className={dateChoice === "custom" ? "selected" : ""} onClick={() => setDateChoice("custom")}><CalendarClock size={14}/>Custom date</button></div>{todayClosure && <p className="today-unavailable-note">{todayClosure} Choose an available school day below.</p>}{dateChoice === "custom" && <SchoolDatePicker id="reflection-date" label="Custom reflection date" value={reflectionDate} disabled={saving} onChange={setReflectionDate}/> }</div>{bookingRefreshing && <p className="booking-check"><LoaderCircle size={13} className="spin"/>Checking the latest session bookings…</p>}{bookingLoadError && <div className="booking-warning" role="alert"><p>{bookingLoadError}</p><button className="text-button" type="button" onClick={refreshBookings}><RotateCcw size={12}/>Check bookings again</button></div>}{hasBookingConflict && (
          <div className="booking-warning" aria-live="polite">
            <strong>Lunch already booked on {formatDate(reflectionDate, { day: "numeric", month: "long" })}</strong>
            <p>{[...new Set(bookedForSelection.map(assignment => studentLabel(studentMap.get(assignment.studentId))))].join(", ")}</p>
            <p>Choose another school day or adjust the student selection.</p>
          </div>
        )}<div className="form-field"><label className="form-label" htmlFor="reflection-reason">Reason <span className="required-label">Required</span></label><textarea id="reflection-reason" required maxLength={1000} rows={3} placeholder="Why is this reflection being assigned?" value={reason} aria-invalid={reasonTouched && !hasReason(reason) ? true : undefined} aria-describedby={reasonTouched && !hasReason(reason) ? "reflection-reason-error" : undefined} onBlur={() => setReasonTouched(true)} onChange={e => setReason(e.target.value)}/>{reasonTouched && !hasReason(reason) && <p id="reflection-reason-error" className="form-error" role="alert">Enter a reason for this reflection.</p>}</div><fieldset className="behaviour-steps" disabled={saving} aria-describedby="behaviour-steps-hint">
          <legend className="form-label">Behaviour steps <span className="required-label">Required</span></legend>
          <p id="behaviour-steps-hint" className="behaviour-steps-hint">Confirm each step before assigning a reflection.</p>
          <div className="behaviour-step-options">
            {behaviourStepLabels.map(({ step, label }) => (
              <label className="behaviour-step-option" key={step}>
                <input type="checkbox" required checked={behaviourSteps[step]} onChange={event => {
                  const checked = event.currentTarget.checked;
                  setBehaviourSteps(previous => ({ ...previous, [step]: checked }));
                }}/>
                {label}
              </label>
            ))}
          </div>
        </fieldset><div className="form-field"><label className="form-label" htmlFor="assigned-by">Assigned by <span>Automatic</span></label><input id="assigned-by" readOnly value={data.user?.name || "School staff"}/></div>{formError && <p className="form-error" role="alert">{formError}</p>}</div><div className="modal-footer"><span><ShieldCheck size={14}/>Saved to the school register</span><div><button className="button secondary" type="button" disabled={saving} onClick={closeModal}>Cancel</button><button className="button primary" type="submit" disabled={saving || bookingRefreshing || !!bookingLoadError || !selectedStudents.length || hasBookingConflict || !hasReason(reason) || !behaviourStepsConfirmed || !!reflectionClosure}>{saving ? <LoaderCircle size={16} className="spin"/> : <Plus size={17}/>} {saving ? "Adding…" : "Send to reflection"}</button></div></div></form></Modal>}
    {isAdmin && rescheduleId && rescheduleSource && <Modal title="Reschedule a missed reflection" subtitle={rescheduleStudent ? `${rescheduleStudent.name} · ${rescheduleStudent.grade} · ${rescheduleStudent.className}` : "Choose a school day for the replacement."} onClose={() => { if (!saving) setRescheduleId(null); }}><form onSubmit={saveReschedule}><div className="modal-body"><div className="reschedule-source"><CalendarClock size={18}/><div><strong>Original missed session</strong><span>{formatDate(rescheduleSource.date, { day: "numeric", month: "long", year: "numeric" })} · {slotLabels[rescheduleSource.slot]}</span><small>The original absence and recorded attendance remain in history.</small></div></div><div className="form-field"><label className="form-label" htmlFor="replacement-date">Replacement lunch date</label><SchoolDatePicker id="replacement-date" label="Replacement lunch date" min={rescheduleSource.date} value={rescheduleDate} disabled={saving} onChange={setRescheduleDate}/></div><p className="reflection-location"><MapPin size={16} aria-hidden="true"/> Lunch break · {reflectionLocation}</p>
        {rescheduleBlocked && (
          <div className="booking-warning" aria-live="polite">
            <strong>Lunch already booked on this date</strong>
            <p>Choose another school day.</p>
          </div>
        )}{bookingRefreshing && <p className="booking-check"><LoaderCircle size={13} className="spin"/>Checking the latest bookings…</p>}{bookingLoadError && <div className="booking-warning"><p>{bookingLoadError}</p><button type="button" className="text-button" onClick={refreshBookings}>Check bookings again</button></div>}{rescheduleHasFollowUps && <p className="form-error" role="alert">This absence already has a follow-up booking. Open the student’s history to review it.</p>}{rescheduleStudent?.active === false && <p className="form-error" role="alert">An admin must restore this student before rescheduling.</p>}{formError && <p className="form-error" role="alert">{formError}</p>}</div><div className="modal-footer"><span><ShieldCheck size={14}/>Original absence retained</span><div><button className="button secondary" type="button" disabled={saving} onClick={() => setRescheduleId(null)}>Cancel</button><button className="button primary" type="submit" disabled={saving || bookingRefreshing || !!bookingLoadError || !rescheduleDate || rescheduleDate < rescheduleSource.date || !!replacementClosure || rescheduleBlocked || rescheduleHasFollowUps || rescheduleStudent?.active === false}>{saving ? <LoaderCircle size={15} className="spin"/> : <CalendarClock size={15}/>}Reschedule</button></div></div></form></Modal>}
    {profileStudent && !accessError && <StudentProfile student={{ ...profileStudent, name: studentLabel(profileStudent) }} assignments={data.assignments} mode={isAdmin ? "full" : "history"} onClose={() => setProfileStudentId(null)}/>}
    {isAdmin && (modal === "student" || modal === "edit-student") && <Modal title={editingStudent ? "Edit student details" : "Add a student"} subtitle={editingStudent ? "Keep your school directory up to date." : "Add a student to your school directory."} onClose={closeModal}><form onSubmit={saveStudentForm}><div className="modal-body"><div className="form-field"><label className="form-label" htmlFor="new-student-name">Full name</label><input id="new-student-name" required maxLength={120} placeholder="Student’s full name" value={newName} onChange={e => setNewName(e.target.value)}/></div><div className="form-row"><div className="form-field"><label className="form-label" htmlFor="new-student-grade">Grade / Year</label><input id="new-student-grade" required maxLength={40} list="grade-options" placeholder="e.g. Year 7" value={newGrade} onChange={e => setNewGrade(e.target.value)}/><datalist id="grade-options">{grades.map(g => <option key={g} value={g}/>)}</datalist></div><div className="form-field"><label className="form-label" htmlFor="new-student-class">Class</label><input id="new-student-class" required maxLength={60} placeholder="e.g. 7A" value={newClass} onChange={e => setNewClass(e.target.value)}/></div></div><p className="form-hint"><Users size={16}/>The student will be available to all teachers using this workspace.</p>{formError && <p className="form-error" role="alert">{formError}</p>}</div><div className="modal-footer"><div/><div><button className="button secondary" type="button" disabled={saving} onClick={closeModal}>Cancel</button><button className="button primary" type="submit" disabled={saving || !newName.trim() || !newGrade.trim() || !newClass.trim()}>{saving ? <LoaderCircle className="spin" size={16}/> : editingStudent ? <Check size={16}/> : <Plus size={16}/>} {editingStudent ? "Save changes" : "Add student"}</button></div></div></form></Modal>}
    {isAdmin && modal === "import" && <Modal title="Import student directory" subtitle="Bring your school roster into one shared directory." onClose={closeModal} wide><div className="modal-body"><div className="import-instructions"><FileText size={21}/><div><strong>A simple CSV file is all you need</strong><p>Include the columns <b>Name</b>, <b>Grade</b> and <b>Class</b>. Existing students are matched by their name, grade and class.</p><button className="text-button" onClick={() => downloadCsv("student-directory-template.csv", [["Name", "Grade", "Class"]])}><ArrowDownToLine size={14}/>Download CSV template</button></div></div><label className="file-drop"><Upload size={24}/><strong>{fileName || "Choose a CSV file"}</strong><span>or paste your CSV below · .csv, .tsv or .txt</span><input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" aria-label="Choose student CSV file" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) { setFormError("Please choose a file smaller than 5 MB."); return; } try { const text = await file.text(); setCsvText(text); setFileName(file.name); setImportPreview([]); setFormError(""); } catch { setFormError("This file could not be read. Please try another CSV."); } }}/></label><div className="form-field"><label className="form-label" htmlFor="csv-data">CSV data</label><textarea id="csv-data" className="csv-textarea" rows={4} value={csvText} placeholder={'Name,Grade,Class\n'} onChange={e => { setCsvText(e.target.value); setImportPreview([]); }}/></div>{formError && <p className="form-error" role="alert">{formError}</p>}{importPreview.length > 0 && <div className="import-preview"><div><Check size={16}/><strong>{importPreview.length} students ready to import</strong></div><table><thead><tr><th>Name</th><th>Grade</th><th>Class</th></tr></thead><tbody>{importPreview.slice(0, 5).map((s, i) => <tr key={i}><td>{s.name}</td><td>{s.grade}</td><td>{s.className}</td></tr>)}</tbody></table>{importPreview.length > 5 && <p>…and {importPreview.length - 5} more students</p>}</div>}</div><div className="modal-footer"><span><ShieldCheck size={14}/>Review before importing</span><div><button className="button secondary" disabled={saving} onClick={closeModal}>Cancel</button>{importPreview.length ? <button className="button primary" disabled={saving} onClick={() => saveStudents(importPreview, importPreview.some(student => student.toddleId) ? "Toddle roster import" : "CSV import")}>{saving ? <LoaderCircle className="spin" size={16}/> : <Upload size={16}/>}Import {importPreview.length} students</button> : <button className="button primary" disabled={!csvText.trim()} onClick={previewImport}>Preview import <ArrowRight size={16}/></button>}</div></div></Modal>}
    {modal === "help" && <Modal title="A shared space for reflection" subtitle="A simple guide for your school team." onClose={closeModal}><div className="modal-body guidance"><div><span>01</span><div><h3>Find the right student</h3><p>Browse the directory by grade and class. Admins manage students and staff access; teachers assign reflections and take attendance. This workspace is for staff only.</p></div></div><div><span>02</span><div><h3>Book a lunch reflection</h3><p>Choose a school day and enter the reason. Reflections take place in the Music Room on the canteen floor during lunch. Each student can attend one reflection per day.</p></div></div><div><span>03</span><div><h3>Record who attended</h3><p>The covering teacher marks each expected student Present or Absent. The register records the staff member and time. Pending means attendance has not been recorded.</p></div></div><div><span>04</span><div><h3>Follow up a missed session</h3><p>Marking a student Absent books two lunches on separate available school days, Monday through Thursday. Admins can review unbooked absences under Follow-up needed.</p></div></div><div><span>05</span><div><h3>Understand each student’s history</h3><p>Open a student’s name to review their full reflection history. Admins and moderators can also compare Student insights and Teacher insights.</p></div></div><p className="staff-access-help"><ShieldCheck size={15}/>Staff sign in with an authorised school Google Workspace account. An administrator manages staff access.</p></div><div className="modal-footer"><span>Pause. Reflect. Grow.</span><button className="button primary" onClick={closeModal}>Got it <Check size={16}/></button></div></Modal>}

    {deleteId && <Modal title="Remove this reflection?" subtitle="This session will be removed from the student’s register." onClose={() => { if (!saving) setDeleteId(null); }}><div className="modal-body"><p className="delete-note">The student will no longer be expected at this reflection session. You can assign it again later if needed.</p></div><div className="modal-footer"><div/><div><button className="button secondary" disabled={saving} onClick={() => setDeleteId(null)}>Keep reflection</button><button className="button danger" disabled={saving} onClick={removeAssignment}>{saving ? <LoaderCircle className="spin" size={16}/> : <Trash2 size={16}/>}Remove reflection</button></div></div></Modal>}
  </div>;
}

function EmptyState({ icon, title, text, action, foot }: { icon: ReactNode; title: string; text: string; action?: ReactNode; foot?: string }) { return <div className="empty-state"><div className="empty-art"><span className="empty-spark one"/><span className="empty-spark two"/><div>{icon}</div><span className="empty-spark three"/></div><h3>{title}</h3><p>{text}</p>{action}<small>{foot}</small></div>; }
