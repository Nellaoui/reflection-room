"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export default function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement; const el = ref.current; const first = el?.querySelector<HTMLElement>("input, button, select, textarea, [tabindex='0']"); first?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); if (event.key === "Tab" && el) { const items = [...el.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea, select, [tabindex='0']")].filter(x => x.offsetParent !== null); if (!items.length) return; if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); } } };
    document.addEventListener("keydown", key); const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-heading"><div><span className="eyebrow">REFLECTION ROOM</span><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div>{children}</div></div>;
}

