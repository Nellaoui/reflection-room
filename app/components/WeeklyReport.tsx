"use client";

import { useEffect, useRef, useState } from "react";
import { CircleCheck, Clock3, LoaderCircle, Mail, RefreshCw } from "lucide-react";
import type { WeeklyReport as ReportPreview, WeeklyReportReadiness } from "@/app/lib/weekly-report";
import "./weekly-report.css";

type PreviewData = {
  preview: ReportPreview; readiness: WeeklyReportReadiness;
  lastDelivery: { weekKey: string; status: "sending" | "sent" | "retryable" | "uncertain"; attempts: number; updatedAt: string } | null;
};

export default function WeeklyReport({ onAccessDenied }: { onAccessDenied?: (status: number, message: string) => void }) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const callback = useRef(onAccessDenied);
  useEffect(() => { callback.current = onAccessDenied; }, [onAccessDenied]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch("/api/reports/weekly", { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json() as PreviewData & { error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const message = body.error || "Could not load the weekly report.";
        if (response.status === 401 || response.status === 403) { setData(null); callback.current?.(response.status, message); }
        setError(message); return;
      }
      setData(body); setError("");
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load the weekly report."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  return <section className="weekly-report" aria-label="Weekly report email preview">
    <div className="register-section">
      <div className="section-heading"><div className="section-title"><Mail size={20}/><h2>Weekly email preview</h2></div><button className="button secondary small" onClick={() => setReload(value => value + 1)} disabled={loading}><RefreshCw size={15}/>Refresh</button></div>
      {error && <div className="error-banner" role="alert"><div><strong>Report unavailable</strong><span>{error}</span></div></div>}
      {loading ? <div className="loading-state"><LoaderCircle className="spin" size={25}/><p>Loading weekly summary…</p></div> : data && <>
        <div className={`weekly-report-schedule ${data.readiness.ready ? "ready" : "paused"}`}><span>{data.readiness.ready ? <CircleCheck size={19}/> : <Clock3 size={19}/>}</span><div><strong>{data.readiness.ready ? "Weekly sending is enabled" : "Automatic sending is off"}</strong><p>Friday afternoon, before 16:00 · Casablanca</p>{data.readiness.missing.length > 0 && <p className="weekly-report-setup">Setup needed: {data.readiness.missing.join(" · ")}</p>}</div></div>
        <dl className="weekly-report-addresses"><div><dt>To</dt><dd>{data.readiness.recipients.length ? data.readiness.recipients.join(", ") : "Recipients awaiting setup"}</dd></div><div><dt>From</dt><dd>{data.readiness.from || "Sender awaiting setup"}</dd></div><div><dt>Subject</dt><dd>{data.preview.subject}</dd></div></dl>
        <article className="weekly-report-email" aria-label="Email body"><iframe title="Weekly report email" sandbox="" referrerPolicy="no-referrer" srcDoc={data.preview.html} style={{ height: Math.min(1800, 1100 + data.preview.tables.students.length * 150 + data.preview.tables.teachers.length * 125) }}/></article>
        <div className="weekly-report-footer"><span>Preview only. No email is sent from this page.</span>{data.lastDelivery && <span>Latest report: week of {data.lastDelivery.weekKey} · {data.lastDelivery.status === "sent" ? "Sent" : data.lastDelivery.status === "sending" ? "Sending" : "Delivery needs review"}</span>}</div>
      </>}
    </div>
  </section>;
}
