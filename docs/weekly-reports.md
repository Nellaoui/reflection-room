# Weekly insight email

Automatic sending is **off by default**. An administrator can review the exact email in **Weekly report** without sending it. Approve the content, recipients and sender before activation. The email contains named student and teacher tables for the scheduled Monday–Friday sessions, without free-text reasons. It includes all students with sessions in that week and all staff with assignment activity. The secure insights link requires staff sign-in and an appropriate role.

## Prepare

1. Back up the database privately. Run `npm run db:migrate` to inspect it, then `npm run db:migrate -- --apply` to apply pending migrations. Migration `0007_weekly_report_deliveries` adds only the delivery ledger; it does not change school records.
2. Connect Resend and verify a school-owned sender domain. Domain verification needs access to the school's DNS. School Google sign-in alone does not grant permission to send email.
3. Set the following **server-only production environment variables** privately in Vercel. Never commit the values or add a `NEXT_PUBLIC_` prefix.

| Variable | Value |
| --- | --- |
| `WEEKLY_REPORT_ENABLED` | Keep `false` until final approval; only exact `true` enables sending. |
| `WEEKLY_REPORT_RECIPIENTS` | The approved email addresses, separated by commas. |
| `WEEKLY_REPORT_FROM` | Verified address, optionally `Reflection Room <address>`. |
| `WEEKLY_REPORT_APP_URL` | Published HTTPS website origin, without a path. |
| `RESEND_API_KEY` | Resend API key with email sending permission. |
| `CRON_SECRET` | A new random secret of at least 16 characters. Vercel sends it as a Bearer token. |

## Activate after approval

The approved Vercel cron job is included in `vercel.json`: `GET /api/cron/weekly-report` with `0 14 * * 5` (Friday 14:00 UTC). Once the sender and service are connected, set `WEEKLY_REPORT_ENABLED=true` in production and redeploy. The route sends nothing while this setting is missing or false. Preview and local environments should keep sending disabled.

The route checks Friday afternoon using the IANA `Africa/Casablanca` time zone and rejects sending at or after 16:00 local time. Keep the Node runtime's time-zone data up to date. Vercel Hobby may invoke the job anywhere within the configured hour; this is a best-effort delivery target, not an exact-time guarantee. A failed invocation is not automatically retried by Vercel.

## Delivery checks

The database ledger claims each school week once. Retries reuse the frozen email and Resend idempotency key. A known provider rejection may be retried after fixing the connection. An uncertain outcome can be retried only within the provider's safe idempotency window; older uncertainty requires checking the provider before another send. Changing recipients or sender prevents an old frozen email from being retried to outdated recipients. A provider acceptance records **Sent**; it does not prove inbox delivery.

See [Vercel Cron](https://vercel.com/docs/cron-jobs), [Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction) and [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
