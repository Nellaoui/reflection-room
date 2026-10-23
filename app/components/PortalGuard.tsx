/* eslint-disable @next/next/no-img-element -- Match the fixed-size native school logo used by the signed-out panel. */
import type { ReactNode } from "react";
import { ArrowUpRight, LogOut, ShieldCheck } from "lucide-react";
import { getStaffIdentity } from "@/app/lib/staff-auth";
import { getPortalAccess, type StaffPortal } from "@/app/lib/portal-access";

export default async function PortalGuard({ portal, children }: { portal: StaffPortal; children: ReactNode }) {
  const access = await getPortalAccess(await getStaffIdentity(), portal);
  if (access.allowed) return children;
  if (access.reason === "anonymous") return null;
  const title = access.reason === "wrong-role" ? "Access restricted" : access.reason === "disabled" ? "Staff access is disabled" : "Staff access required";
  const message = access.reason === "wrong-role"
    ? "This view is not available to your staff role. Open your workspace to continue."
    : access.reason === "disabled"
      ? "Your school administrator has disabled this account. Contact them to restore access."
      : "Your signed-in account has not been authorised for this school workspace. Contact your school administrator.";
  return (
    <main className="auth-screen">
      <div className="auth-school"><img src="/school-logo.png" width={60} height={60} alt="London Academy"/><div><strong>London Academy</strong><span>Bouskoura campus</span></div></div>
      <section className="auth-card" aria-labelledby="portal-access-title">
        <span className="auth-status-icon"><ShieldCheck size={26} aria-hidden="true"/></span>
        <div className="auth-eyebrow">REFLECTION ROOM</div>
        <h1 id="portal-access-title">{title}</h1>
        <p>{message}</p>
        {access.reason === "wrong-role" && <a className="button primary auth-sign-in" href="/">Open your workspace <ArrowUpRight size={16} aria-hidden="true"/></a>}
        <form method="POST" action="/auth/logout" target="_top"><button type="submit" className="button secondary auth-sign-in"><LogOut size={16} aria-hidden="true"/> Sign out</button></form>
        <div className="auth-staff-note"><ShieldCheck size={15} aria-hidden="true"/> Access follows your authorised staff role.</div>
      </section>
    </main>
  );
}
