"use client";

import { useState } from "react";
import Modal from "./Modal";
import type { LunchCutoverPlan } from "@/app/lib/lunch-cutover";

const endpoint = "/api/assignments/lunch-cutover";

class CutoverRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function requestCutover(planId?: string) {
  const response = await fetch(endpoint, {
    cache: "no-store",
    ...(planId ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId }),
    } : {}),
  });
  const result = await response.json().catch(() => null) as
    (LunchCutoverPlan & { moved?: number; error?: string }) | null;
  if (!response.ok || !result) {
    throw new CutoverRequestError(result?.error || "Could not load or save the booking moves. Try again.", response.status);
  }
  return result;
}

function formatDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
}

export default function LunchCutover({ pendingCount, onComplete, onAccessDenied }: {
  pendingCount: number;
  onComplete: (moved: number) => void | Promise<void>;
  onAccessDenied?: (status: number, message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<LunchCutoverPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function showError(failure: unknown) {
    const message = failure instanceof Error ? failure.message : "Could not move the bookings. Try again.";
    if (failure instanceof CutoverRequestError && (failure.status === 401 || failure.status === 403)) {
      onAccessDenied?.(failure.status, message);
    }
    setError(message);
  }

  async function review() {
    setOpen(true);
    setPlan(null);
    setError("");
    setBusy(true);
    try {
      setPlan(await requestCutover());
    } catch (failure) {
      showError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!plan || busy) return;
    setError("");
    setBusy(true);
    try {
      const result = await requestCutover(plan.planId);
      setOpen(false);
      await onComplete(result.moved ?? 0);
    } catch (failure) {
      setPlan(null);
      showError(failure);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <section className="register-section no-print" aria-label="Move morning bookings">
      <div className="section-heading">
        <div className="section-title"><h2>{pendingCount} pending morning {pendingCount === 1 ? "booking" : "bookings"}</h2></div>
        <button type="button" className="button secondary small" onClick={() => void review()}>Review moves to lunch</button>
      </div>
    </section>
    {open && <Modal title="Move morning bookings to lunch" onClose={() => { if (!busy) setOpen(false); }} wide>
      <div className="modal-body" aria-busy={busy}>
        {busy && <p role="status">{plan ? "Moving bookings…" : "Finding available lunch dates…"}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {plan && <>
          <p className="form-hint">Each booking moves to the first free school-day lunch for that student. Overdue bookings start from {formatDate(plan.schoolDate)}.</p>
          {plan.blocked.length > 0 && <p className="form-error" role="alert">The verified school calendar has no available lunch date for {plan.blocked.length} {plan.blocked.length === 1 ? "booking" : "bookings"}. Update the calendar before moving the bookings.</p>}
          {plan.moves.length === 0 && plan.blocked.length === 0 && <p>No pending morning bookings remain.</p>}
          {plan.moves.length > 0 && <div className="table-scroll">
            <table className="register-table" aria-label="Proposed lunch dates">
              <thead><tr><th scope="col">Student</th><th scope="col">Morning booking</th><th scope="col">New lunch date</th></tr></thead>
              <tbody>{plan.moves.map(move => <tr key={move.id}>
                <td>{move.studentName}</td><td>{formatDate(move.fromDate)}</td><td>{formatDate(move.toDate)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </>}
      </div>
      <div className="modal-footer">
        <div>
          <button type="button" className="button secondary" disabled={busy} onClick={() => setOpen(false)}>Close</button>
          {error && <button type="button" className="button secondary" disabled={busy} onClick={() => void review()}>Refresh dates</button>}
          {plan && plan.moves.length > 0 && plan.blocked.length === 0 &&
            <button type="button" className="button primary" disabled={busy} onClick={() => void apply()}>Move {plan.moves.length} {plan.moves.length === 1 ? "booking" : "bookings"} to lunch</button>}
        </div>
      </div>
    </Modal>}
  </>;
}
