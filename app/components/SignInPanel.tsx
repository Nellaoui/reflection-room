/* eslint-disable @next/next/no-img-element -- Match the fixed-size official school logo used by the workspace. */
import { ArrowUpRight, LockKeyhole, ShieldCheck } from "lucide-react";
import "./sign-in-panel.css";

type SignInPanelProps = {
  googleReady?: boolean;
};

function GoogleMark() {
  return (
    <svg className="rr-google-mark" viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.06.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.05v2.59A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.05a10 10 0 0 0 0 9.02l3.35-2.59Z" />
      <path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.61 9.61 0 0 0 12 2a10 10 0 0 0-8.95 5.49l3.35 2.59A6 6 0 0 1 12 5.96Z" />
    </svg>
  );
}

export default function SignInPanel({
  googleReady = false,
}: SignInPanelProps = {}) {
  return (
    <main className="rr-sign-in">
      <div className="rr-sign-in-shell">
        <div className="rr-sign-in-school">
          <img src="/school-logo.png" width={72} height={72} alt="London Academy" />
          <div><strong>London Academy</strong><span>Bouskoura campus</span></div>
        </div>

        <section className="rr-sign-in-card" aria-labelledby="staff-sign-in-title">
          <header className="rr-sign-in-heading">
            <h1 id="staff-sign-in-title">Reflection Room</h1>
            <p>Sign in with your school Google account.</p>
            <span className="rr-school-domain">@elitelac.com</span>
          </header>

          {!googleReady && (
            <div className="rr-google-setup" id="google-sign-in-status" role="status">
              <ShieldCheck size={17} aria-hidden="true" />
              <p>Google sign-in is being configured.</p>
            </div>
          )}

          {googleReady ? (
            <a className="rr-google-sign-in" href="/auth/google" target="_top"><GoogleMark /><span>Continue with Google</span><ArrowUpRight size={15} aria-hidden="true" /></a>
          ) : (
            <button className="rr-google-sign-in" type="button" disabled aria-describedby="google-sign-in-status"><GoogleMark /><span>Continue with Google</span><LockKeyhole size={14} aria-hidden="true" /></button>
          )}
        </section>

        <footer className="rr-sign-in-footer"><ShieldCheck size={15} aria-hidden="true" /><span>Authorised school staff only.</span></footer>
      </div>
    </main>
  );
}
