# Reflection Room · London Academy

A staff workspace for morning and lunch break reflections, attendance, missed sessions and student history.

- One Google sign-in for `@elitelac.com` staff. Any verified school Google account joins as a Teacher on first sign-in.
- Admins can switch between Admin, Teacher and Moderator views.
- Moderators have Teacher tools and a separate view containing only Student and Teacher insights.
- Teachers assign sessions and record attendance, with no access to insights. Students have no access.
- Attendance uses green for present, red for absent and blue for pending. Insight count colours compare initial assignments within the selected filters; follow-ups are counted separately.

## Run locally

Use Node.js 24. Run `npm ci`, configure the private values in `.env.local` using `.env.example`, then run `npm run dev`.

## Deploy to Vercel

Import this repository as a Next.js project. Connect the Turso Cloud database and add these server environment variables:

`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

The Google callback must be exactly `https://YOUR-DOMAIN/auth/google/callback`. Create one internal Google OAuth web client for the school; teachers do not create OAuth clients. Never commit secrets.

Run `npm run db:migrate` to inspect the database, then `npm run db:migrate -- --apply` to initialise an empty database or apply pending migrations to a verified database. Keep a private backup before upgrades. The runner accepts only an exact checked-in migration prefix with a matching schema; it never stamps an unrelated database. Existing school data is transferred privately, separately from source control.

The first verified login by `t-wiam-zahri@elitelac.com` creates the initial administrator. Every other verified `@elitelac.com` Google account is added automatically as a Teacher the first time it signs in. Administrators can still add accounts ahead of time, change roles to Moderator or Admin, and disable or delete accounts in User management; disabled or deleted accounts stay blocked.

## Checks

`npm test` and `npm run build`.
