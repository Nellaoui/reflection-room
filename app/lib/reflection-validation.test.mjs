import assert from "node:assert/strict";
import test from "node:test";
import { assignmentInput, attendanceInput, rosterInput, validDate, userCreateInput, userPatchInput } from "./reflection-validation.ts";

test("calendar dates reject rolled-over days while allowing weekends and leap days", () => {
  assert.equal(validDate("2028-02-29"), "2028-02-29");
  assert.equal(validDate("2026-10-24"), "2026-10-24");
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-02", "tomorrow"]) {
    assert.throws(() => validDate(date));
  }
});

test("a student can receive both sessions and repeated IDs are deduplicated", () => {
  assert.deepEqual(assignmentInput({ studentIds: ["pupil-1", "pupil-1"], slots: ["morning", "lunch"], date: "2026-10-22", reason: "", assignedBy: "" }, "A Teacher"), {
    studentIds: ["pupil-1"], slots: ["morning", "lunch"], date: "2026-10-22", reason: "", assignedBy: "A Teacher",
  });
  assert.throws(() => assignmentInput({ studentIds: ["pupil-1"], slots: ["afternoon"], date: "2026-10-22" }, "Teacher"));
});

test("roster import deduplicates spelling case and whitespace within the same grade and class", () => {
  const result = rosterInput({ source: "Toddle", students: [
    { name: "  Example   Student ", grade: "Grade 7", className: "7A" },
    { name: "example student", grade: "grade 7", className: "7a" },
    { name: "Example Student", grade: "Grade 7", className: "7B" },
  ] });
  assert.equal(result.students.length, 2);
  assert.equal(result.students[0].name, "example student");
  assert.equal(result.students[1].className, "7B");
});

test("roster validation rejects missing classes, oversized batches, and long names", () => {
  assert.throws(() => rosterInput({ source: "Toddle", students: [{ name: "Example", grade: "Grade 7", className: "" }] }));
  assert.throws(() => rosterInput({ source: "Toddle", students: new Array(2001).fill({ name: "Example", grade: "Grade 7", className: "7A" }) }));
  assert.throws(() => rosterInput({ source: "Toddle", students: [{ name: "x".repeat(121), grade: "Grade 7", className: "7A" }] }));
});

test("attendance accepts only the three register states", () => {
  for (const status of ["pending", "present", "absent"]) assert.equal(attendanceInput({ status }), status);
  assert.throws(() => attendanceInput({ status: "unknown" }));
});

test("staff roles include moderator while unrecognized roles remain invalid", () => {
  assert.equal(userCreateInput({ name: "School Moderator", email: "moderator@elitelac.com", role: "moderator" }).role, "moderator");
  assert.deepEqual(userPatchInput({ role: "moderator" }), { role: "moderator" });
  for (const role of ["owner", "student", "MODERATOR", null, ""]) {
    assert.throws(() => userPatchInput({ role }));
  }
});
