import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const students = sqliteTable("students", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  grade: text("grade").notNull(),
  className: text("class_name").notNull(),
  rosterKey: text("roster_key").notNull(),
  toddleId: text("toddle_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("students_roster_key_unique").on(table.rosterKey),
  uniqueIndex("students_toddle_id_unique").on(table.toddleId),
  index("students_grade_class_idx").on(table.grade, table.className),
]);

export const reflectionAssignments = sqliteTable("reflection_assignments", {
  id: text("id").primaryKey(),
  studentId: text("student_id").notNull().references(() => students.id),
  date: text("date").notNull(),
  slot: text("slot", { enum: ["morning", "lunch"] }).notNull(),
  reason: text("reason").notNull().default(""),
  assignedBy: text("assigned_by").notNull(),
  status: text("status", { enum: ["pending", "present", "absent"] }).notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  cancelledAt: text("cancelled_at"),
  cancelledByUserId: text("cancelled_by_user_id"),
  attendanceRecordedBy: text("attendance_recorded_by"),
  attendanceRecordedAt: text("attendance_recorded_at"),
  rescheduledFromId: text("rescheduled_from_id").references((): AnySQLiteColumn => reflectionAssignments.id),
}, (table) => [
  uniqueIndex("assignments_student_date_slot_unique").on(table.studentId, table.date, table.slot).where(sql`${table.cancelledAt} IS NULL`),
  uniqueIndex("assignments_source_active_unique").on(table.rescheduledFromId).where(sql`${table.cancelledAt} IS NULL`),
  index("assignments_date_idx").on(table.date),
  check("assignments_slot_check", sql`${table.slot} IN ('morning', 'lunch')`),
  check("assignments_status_check", sql`${table.status} IN ('pending', 'present', 'absent')`),
]);

export const rosterMetadata = sqliteTable("roster_metadata", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  importedAt: text("imported_at").notNull(),
  importedCount: integer("imported_count").notNull(),
  importedByUserId: text("imported_by_user_id").notNull(),
});

export const appUsers = sqliteTable("app_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: text("role", { enum: ["admin", "teacher", "moderator"] }).notNull(),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  linkedUserId: text("linked_user_id"),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  deletedAt: text("deleted_at"),
}, (table) => [
  uniqueIndex("app_users_email_unique").on(table.email),
  uniqueIndex("app_users_linked_user_unique").on(table.linkedUserId),
  check("app_users_role_check", sql`${table.role} IN ('admin', 'teacher', 'moderator')`),
  check("app_users_status_check", sql`${table.status} IN ('active', 'disabled')`),
]);

// Snapshot names remain readable if an account is renamed or removed later.
// Entries are written only by successful server mutations, in the same batch.
export const activityEvents = sqliteTable("activity_events", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  actorName: text("actor_name").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  targetName: text("target_name").notNull(),
  details: text("details").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("activity_events_created_idx").on(table.createdAt)]);

export const staffGoogleIdentities = sqliteTable("staff_google_identities", {
  subject: text("subject").primaryKey(),
  memberId: text("member_id").notNull().references(() => appUsers.id),
  email: text("email").notNull(),
  createdAt: integer("created_at").notNull(),
  lastAuthenticatedAt: integer("last_authenticated_at").notNull(),
}, (table) => [uniqueIndex("staff_google_member_unique").on(table.memberId)]);

export const staffSessions = sqliteTable("staff_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  memberId: text("member_id").notNull().references(() => appUsers.id),
  googleSubject: text("google_subject").notNull().references(() => staffGoogleIdentities.subject),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("staff_sessions_expiry_idx").on(table.expiresAt)]);

export const staffOauthChallenges = sqliteTable("staff_oauth_challenges", {
  stateHash: text("state_hash").primaryKey(),
  browserHash: text("browser_hash").notNull(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  portal: text("portal", { enum: ["admin", "teacher", "moderator"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("staff_oauth_expiry_idx").on(table.expiresAt), check("staff_oauth_portal_check", sql`${table.portal} IN ('admin', 'teacher', 'moderator')`)]);
