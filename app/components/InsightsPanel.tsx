"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCcw, ShieldCheck } from "lucide-react";
import StudentInsights, { type Student } from "./StudentInsights";
import TeacherInsights, { type InsightAssignment, type InsightTeacher } from "./TeacherInsights";
import StudentProfile from "./StudentProfile";

export type InsightView = "students" | "teachers";
export type InsightData = { students: Student[]; assignments: InsightAssignment[]; teachers: InsightTeacher[]; user: { name: string; email: string; role: "admin" | "moderator" } };

export default function InsightsPanel({ view, onAccessDenied, onUser }: { view: InsightView; onAccessDenied?: (status: number, message: string) => void; onUser?: (user: InsightData["user"]) => void }) {
  const [data, setData] = useState<InsightData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null);
  const callbacks = useRef({ onAccessDenied, onUser });
  useEffect(() => { callbacks.current = { onAccessDenied, onUser }; }, [onAccessDenied, onUser]);

  useEffect(() => {
    const controller = new AbortController();
    let first = true;
    async function load() {
      if (first) setLoading(true);
      try {
        const response = await fetch("/api/insights", { cache: "no-store", signal: controller.signal });
        const body = await response.json() as InsightData & { error?: string };
        if (controller.signal.aborted) return;
        if (!response.ok) {
          const message = body.error || "Could not load insights.";
          if (response.status === 401 || response.status === 403) {
            setData(null); setSelectedStudent(null); setDenied(true);
            callbacks.current.onAccessDenied?.(response.status, message);
          }
          setError(message); return;
        }
        setData(body); setError(""); setDenied(false); callbacks.current.onUser?.(body.user);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load insights.");
      } finally {
        if (!controller.signal.aborted) { setLoading(false); first = false; }
      }
    }
    void load();
    const sync = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(sync, 15000);
    window.addEventListener("focus", sync);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", sync); };
  }, [retry]);

  const student = data?.students.find(item => item.id === selectedStudent);
  return <>
    {error && <div className="error-banner" role="alert"><div><strong>{denied ? "Insights access required" : "Insights could not be refreshed"}</strong><span>{error}</span></div><button className="button secondary small" onClick={() => setRetry(value => value + 1)}><RotateCcw size={14}/>Try again</button></div>}
    {loading ? <div className="loading-state"><LoaderCircle size={25} className="spin"/><p>Loading insights…</p></div> : data && !denied ? <>
      {view === "students" ? <StudentInsights students={data.students} assignments={data.assignments} onOpenStudent={setSelectedStudent}/> : <TeacherInsights students={data.students} assignments={data.assignments} teachers={data.teachers}/>}
      {view === "students" && student && <StudentProfile student={student} assignments={data.assignments} mode="insights" onClose={() => setSelectedStudent(null)}/>}
    </> : !error && <div className="loading-state"><ShieldCheck size={25}/><p>Insights are available to admins and moderators.</p></div>}
  </>;
}
