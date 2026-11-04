import { timingSafeEqual } from "node:crypto";
import { json } from "@/app/lib/reflection-api";
import { dispatchWeeklyReport } from "@/app/lib/weekly-report-delivery";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization") || "";
  const expected = `Bearer ${secret || ""}`;
  if (!secret || secret.length < 16 || Buffer.byteLength(provided) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return json({ error: "Not authorised." }, 401);
  try {
    const result = await dispatchWeeklyReport();
    if (result.reason === "setup_required") return json({ error: "Weekly email setup is incomplete." }, 503);
    if (result.status === "retryable" || result.status === "uncertain") return json({ error: "Email delivery needs review before confirmation.", status: result.status }, 503);
    return json({ ok: true, ...result });
  } catch {
    console.error("Weekly report delivery could not be completed.");
    return json({ error: "Weekly email delivery is unavailable." }, 503);
  }
}
