"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, X } from "lucide-react";
import { DayPicker, labelDayButton } from "react-day-picker";
import { schoolCalendar, schoolDayClosure } from "@/app/lib/school-calendar";
import "react-day-picker/style.css";
import "./school-date-picker.css";

function dateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function asDate(value: string): Date { return new Date(`${value}T12:00:00`); }

export default function SchoolDatePicker({ id, label, value, onChange, min, disabled = false }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const minimum = min && min > schoolCalendar.startDate ? min : schoolCalendar.startDate;
  const maximum = schoolCalendar.endDate;
  const rangeUnavailable = minimum > maximum;
  const selected = value ? asDate(value) : undefined;
  const closure = value ? schoolDayClosure(value) : null;
  const displayDate = selected && Number.isFinite(selected.getTime())
    ? selected.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric" })
    : "Choose a school day";
  const preferredMonth = value || dateValue(new Date());
  const initialMonth = asDate(preferredMonth < minimum ? minimum : preferredMonth > maximum ? maximum : preferredMonth);
  const blocked = (date: Date) => {
    const dateString = dateValue(date);
    return dateString < minimum || dateString > maximum || !!schoolDayClosure(dateString);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  function close() { setOpen(false); trigger.current?.focus(); }

  return <div className="school-date-picker" ref={root} onKeyDown={event => {
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button id={id} ref={trigger} type="button" className="school-date-trigger" aria-label={`${label}: ${displayDate}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-calendar`}
      aria-describedby={`${id}-description`} aria-invalid={closure ? true : undefined}
      disabled={disabled || rangeUnavailable} onClick={() => setOpen(current => !current)}>
      <CalendarDays size={18} aria-hidden="true"/><span>{displayDate}</span><ChevronDown size={16} aria-hidden="true"/>
    </button>
    <p id={`${id}-description`} className="school-date-note">{rangeUnavailable ? "No school dates are available after this session in the current calendar." : "Weekends and school holidays are unavailable."}</p>
    {closure && <p className="form-error" role="alert">{closure}</p>}
    {open && !rangeUnavailable && <div id={`${id}-calendar`} className="school-date-panel" role="dialog" aria-label={`${label} calendar`}>
      <div className="school-date-panel-heading"><strong>School calendar</strong><button type="button" className="icon-button" aria-label="Close school calendar" onClick={close}><X size={17}/></button></div>
      <DayPicker mode="single" required autoFocus weekStartsOn={1} captionLayout="dropdown"
        defaultMonth={initialMonth} selected={selected} startMonth={asDate(minimum)} endMonth={asDate(maximum)}
        disabled={blocked} showOutsideDays={false}
        labels={{ labelDayButton: (date, modifiers, options, dateLib) => {
          const description = schoolDayClosure(dateValue(date));
          const existing = labelDayButton(date, modifiers, options, dateLib);
          return description ? `${existing}. ${description}` : existing;
        } }}
        onSelect={date => { if (!date || blocked(date)) return; onChange(dateValue(date)); close(); }}/>
      <div className="school-date-calendar-key"><span><i/>Unavailable</span><span>{schoolCalendar.academicYear} · Casa campus</span></div>
    </div>}
  </div>;
}
