export function authRedirect(path: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: path, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

const messages = {
  setup: ["School sign-in is not connected yet", "The school administrator needs to connect the Google Workspace application before staff can sign in."],
  expired: ["Please try signing in again", "This sign-in request has expired or has already been used. Return to the sign-in page to start a new request."],
  account: ["School account required", "Use an approved @elitelac.com Google Workspace account. Contact your school administrator if you need staff access."],
  role: ["Access restricted", "This view is not available to your staff role. Return to the sign-in page to open your workspace."],
  failed: ["Sign-in was not completed", "Return to the sign-in page and try again. If this continues, contact your school administrator."],
} as const;

export function authFailure(kind: keyof typeof messages, status: number, cookies: string[] = []): Response {
  const [title, detail] = messages[kind];
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'self'" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Reflection Room</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f9f4;color:#263b2c;font:15px Arial,sans-serif}main{max-width:430px;margin:24px;padding:36px;background:#fff;border:1px solid #e2e7dc;border-top:3px solid #0e5403;border-radius:12px;text-align:center}img{width:60px;height:60px}h1{font-size:25px;font-weight:500}p{color:#6d7b68;line-height:1.8}a{display:inline-block;background:#0e5403;color:#fff;text-decoration:none;padding:13px 22px;border-radius:6px}</style><main><img src="/school-logo.png" alt="London Academy"><h1>${title}</h1><p>${detail}</p><a href="/" target="_top">Back to staff sign in</a></main></html>`, { status, headers });
}
