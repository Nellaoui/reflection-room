"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { History, LoaderCircle, RotateCcw, Search, X } from "lucide-react";

type ActivityEvent = {
  id: string;
  actorName: string;
  action: string;
  targetName: string;
  details: string;
  createdAt: string;
};
type ActivityResponse = { events?: ActivityEvent[]; limit?: number; error?: string };
const activityLabels: Record<string, string> = {
  "staff.created": "User added",
  "staff.updated": "User updated",
  "staff.deleted": "User deleted",
  "student.created": "Student added",
  "student.updated": "Student updated",
  "student.archived": "Student archived",
  "roster.imported": "Students imported",
  "reflection.assigned": "Reflection assigned",
  "reflection.cancelled": "Reflection removed",
  "reflection.rescheduled": "Reflection rescheduled",
  "attendance.recorded": "Attendance recorded",
};

class ActivityAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ActivityAccessError"; }
}
async function requestActivity(signal?: AbortSignal): Promise<ActivityResponse> {
  const response = await fetch("/api/activity", { cache: "no-store", signal });
  const result = await response.json().catch(() => ({})) as ActivityResponse;
  if (!response.ok) throw new ActivityAccessError(result.error || "Could not load activity. Please try again.", response.status);
  return result;
}

function activityLabel(action: string) { return activityLabels[action] || action.replaceAll(".", " ").replaceAll("_", " "); }
function activityTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ActivityLog({ onAccessDenied }: { onAccessDenied: (status: number, message: string) => void }) {
  const deniedRef = useRef(onAccessDenied);
  useEffect(() => { deniedRef.current = onAccessDenied; }, [onAccessDenied]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [limit, setLimit] = useState(300);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  function reportError(error: unknown) {
    if (error instanceof ActivityAccessError && (error.status === 401 || error.status === 403)) deniedRef.current(error.status, error.message);
    return error instanceof Error ? error.message : "Could not load activity.";
  }
  async function refresh() {
    setLoading(true); setError("");
    try {
      const result = await requestActivity();
      setEvents(result.events || []); setLimit(result.limit || 300);
    } catch (error) { setError(reportError(error)); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    void requestActivity(controller.signal)
      .then(result => { if (!controller.signal.aborted) { setEvents(result.events || []); setLimit(result.limit || 300); } })
      .catch(error => { if (!controller.signal.aborted) setError(reportError(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return events.filter(event => !search || `${event.actorName} ${activityLabel(event.action)} ${event.targetName} ${event.details}`.toLowerCase().includes(search));
  }, [events, query]);

  return <section className="register-section activity-log" aria-label="Activity log" aria-busy={loading}>
    <div className="section-heading activity-section-heading">
      <div className="section-title"><h2>Recent activity</h2><span className="count-badge">{events.length}</span></div>
      <button className="button secondary small no-print" onClick={refresh} disabled={loading}>
        {loading ? <LoaderCircle size={15} className="spin"/> : <RotateCcw size={15}/>}Refresh
      </button>
    </div>
    <div className="register-filters activity-filters no-print">
      <div className="search-field"><Search size={17}/><input aria-label="Search activity" placeholder="Search staff, students or activity…" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="Clear activity search" onClick={() => setQuery("")}><X size={14}/></button>}</div>
      <span>Newest first · up to {limit} events</span>
    </div>
    {error && <div className="admin-inline-error" role="alert"><span>{error}</span><button className="text-button" disabled={loading} onClick={refresh}>Try again</button></div>}
    {loading && !events.length ? <div className="loading-state" role="status"><LoaderCircle size={25} className="spin"/><p>Loading activity…</p></div>
      : !filtered.length && !error ? <div className="empty-state"><div className="empty-art"><div><History size={29} strokeWidth={1.4}/></div></div><h3>{events.length ? "No matching activity" : "No activity yet"}</h3><p>{events.length ? "Try a different name or action." : "New staff actions will appear here."}</p>{query && <button className="button secondary" onClick={() => setQuery("")}>Clear search</button>}</div>
      : filtered.length > 0 ? <div className="table-scroll activity-table-wrap"><table className="register-table activity-table">
        <thead><tr><th scope="col">When</th><th scope="col">Staff</th><th scope="col">Activity</th><th scope="col">Details</th></tr></thead>
        <tbody>{filtered.map(event => <tr key={event.id}>
          <td data-label="When"><time dateTime={event.createdAt}>{activityTime(event.createdAt)}</time></td>
          <td data-label="Staff">{event.actorName || "School staff"}</td>
          <td data-label="Activity"><span className={`activity-action ${event.action.endsWith("deleted") || event.action.endsWith("cancelled") ? "activity-removal" : ""}`}>{activityLabel(event.action)}</span></td>
          <td data-label="Details"><div>{event.targetName && <strong>{event.targetName}</strong>}{event.details && <span>{event.details}</span>}{!event.targetName && !event.details && "—"}</div></td>
        </tr>)}</tbody>
      </table></div> : null}
    {events.length > 0 && <div className="activity-footer" aria-live="polite">{filtered.length} of {events.length} recent events</div>}
  </section>;
}
