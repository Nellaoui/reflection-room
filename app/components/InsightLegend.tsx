export function assignmentLevel(count: number, maximum: number): "lower" | "middle" | "higher" {
  if (!maximum || count / maximum <= 1 / 3) return "lower";
  return count / maximum <= 2 / 3 ? "middle" : "higher";
}

export function AttendanceLegend() {
  return <div className="attendance-colour-key" aria-label="Attendance colour key"><span><i className="key-present"/>Present</span><span><i className="key-absent"/>Absent</span><span><i className="key-pending"/>Pending</span></div>;
}

export default function InsightLegend() {
  return <div className="insights-colour-legend"><AttendanceLegend/><div className="assignment-colour-key" aria-label="Initial assignment count colour key"><span>Initial assignments:</span><span><i className="key-lower"/>Lower count</span><span><i className="key-middle"/>Mid-range</span><span><i className="key-higher"/>Higher count</span></div><small>Assignment colours compare initial session counts with the highest count in this filtered view.</small></div>;
}
