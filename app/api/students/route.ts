import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rosterMetadata, students } from "@/db/schema";
import { ApiError, authenticatedApi, json, readJson } from "@/app/lib/reflection-api";
import { chunks, makeRosterKey, rosterInput } from "@/app/lib/reflection-validation";
import { requireAdmin } from "@/app/lib/reflection-membership";
import { activityStatement } from "@/app/lib/reflection-activity";

export async function POST(request: Request) {
  return authenticatedApi(request, true, async (user) => {
    requireAdmin(user);
    const input = rosterInput(await readJson(request));
    const db = getDb();
    const directory = await db.select({ name: students.name, grade: students.grade, className: students.className, rosterKey: students.rosterKey, toddleId: students.toddleId }).from(students);
    const byDisplay = new Map<string, typeof directory>();
    for (const row of directory) {
      const key = makeRosterKey(row.name, row.grade, row.className);
      byDisplay.set(key, [...(byDisplay.get(key) || []), row]);
    }
    const resolved = new Map<string, typeof input.students[number]>();
    for (const row of input.students) {
      const candidates = row.toddleId ? [] : byDisplay.get(row.rosterKey) || [];
      if (candidates.length > 1) throw new ApiError(409, "Several pupil profiles share a name, grade, and class. Include their ToddleID column to identify each profile safely.");
      const existing = candidates[0];
      const next = existing?.toddleId ? { ...row, toddleId: existing.toddleId, rosterKey: existing.rosterKey } : row;
      const previous = resolved.get(next.rosterKey);
      if (previous && (previous.name !== next.name || previous.grade !== next.grade || previous.className !== next.className)) {
        throw new ApiError(400, "The import contains conflicting details for the same pupil identity.");
      }
      resolved.set(next.rosterKey, next);
    }
    input.students = [...resolved.values()];
    const directoryKeys = new Set(directory.map(row => row.rosterKey));
    const existingKeys = new Set(input.students.filter(row => directoryKeys.has(row.rosterKey)).map(row => row.rosterKey));
    const now = new Date().toISOString();
    const rows = input.students.map((student) => ({
        ...student,
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      }));
    const statements = chunks(rows, 9).map((group) =>
      db.insert(students).values(group).onConflictDoUpdate({
        target: students.rosterKey,
        set: {
          name: sql`excluded.name`,
          grade: sql`excluded.grade`,
          className: sql`excluded.class_name`,
          toddleId: sql`excluded.toddle_id`,
          updatedAt: now,
          active: true,
        },
      })
    );
    const metadataStatement = db.insert(rosterMetadata).values({
      id: "roster",
      source: input.source,
      importedAt: now,
      importedCount: input.students.length,
      importedByUserId: user.userId,
    }).onConflictDoUpdate({
      target: rosterMetadata.id,
      set: {
        source: input.source,
        importedAt: now,
        importedCount: input.students.length,
        importedByUserId: user.userId,
      },
    });
    const row = rows[0];
    const event = input.source === "Manual entry" && rows.length === 1
      ? activityStatement(user, {
        action: sql`CASE WHEN (SELECT id FROM students WHERE roster_key = ${row.rosterKey}) = ${row.id} THEN 'student.created' ELSE 'student.updated' END`,
        targetType: "student", targetId: sql`(SELECT id FROM students WHERE roster_key = ${row.rosterKey})`,
        targetName: row.name, details: `${row.grade} · ${row.className}`, createdAt: now,
      })
      : activityStatement(user, {
        action: "roster.imported", targetType: "roster", targetId: "roster", targetName: input.source,
        details: `${input.students.length} student profiles saved`, createdAt: now,
      });
    await db.batch([statements[0], ...statements.slice(1), metadataStatement, event]);
    return json({
      ok: true,
      imported: input.students.length,
      created: input.students.length - existingKeys.size,
      updated: existingKeys.size,
      source: input.source,
      importedAt: now,
    });
  });
}
