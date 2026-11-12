import assert from "node:assert/strict";
import test from "node:test";
import { assignmentInput, attendanceInput, rosterInput, validDate, userCreateInput, userPatchInput } from "./reflection-validation.ts";

const behaviourSteps = { chance: true, choice: true, consequence: true, none: false };

test("generic calendar dates reject rollovers without restricting history date filters", () => {
  assert.equal(validDate("2028-02-29"), "2028-02-29");
  assert.equal(validDate("2026-10-24"), "2026-10-24");
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-02", "tomorrow"]) {
    assert.throws(() => validDate(date));
  }
});

test("a student can receive lunch reflection and repeated IDs are deduplicated", () => {
  assert.deepEqual(assignmentInput({ studentIds: ["pupil-1", "pupil-1"], slots: ["lunch"], date: "2026-10-22", reason: "  Disruption\n during\tclass.  ", behaviourSteps, assignedBy: "" }, "A Teacher"), {
    studentIds: ["pupil-1"], slot: "lunch", date: "2026-10-22", reason: "Disruption during class.", behaviourSteps, assignedBy: "A Teacher",
  });
  assert.throws(() => assignmentInput({ studentIds: ["pupil-1"], slots: ["afternoon"], date: "2026-10-22", reason: "Disruption during class." }, "Teacher"), /lunch break only/);
});

test("new assignments require a visible nonblank reason with the existing length limit", () => {
  const input = { studentIds: ["pupil-1"], slots: ["lunch"], date: "2026-10-22", behaviourSteps };
  for (const reason of [undefined, null, "", " \t\n ", "\u00a0\u3000", "\u200b\u200c\u2060"]) {
    assert.throws(() => assignmentInput({ ...input, reason }, "Teacher"), /Reason is required/);
  }
  for (const reason of [42, false, {}, []]) assert.throws(() => assignmentInput({ ...input, reason }, "Teacher"), /Reason must be text/);
  assert.throws(() => assignmentInput({ ...input, reason: "x".repeat(1001) }, "Teacher"), /1000 characters/);
  assert.equal(assignmentInput({ ...input, reason: "Ａ reminder to reflect." }, "Teacher").reason, "A reminder to reflect.");
  assert.equal(assignmentInput({ ...input, reason: "x".repeat(1000) }, "Teacher").reason.length, 1000);
});

test("behaviour steps require a boolean selection or None on its own", () => {
  const input = { studentIds: ["pupil-1"], slots: ["lunch"], date: "2026-10-22", reason: "Fixture reason" };
  const noSteps = { chance: false, choice: false, consequence: false, none: false };
  for (const steps of [undefined, null, [], true, {}, noSteps, { chance: true, choice: false, consequence: false }]) {
    assert.throws(() => assignmentInput({ ...input, behaviourSteps: steps }, "Teacher"), /Select at least one behaviour step/);
  }
  for (const step of Object.keys(behaviourSteps)) {
    for (const value of [null, 1, "true"]) {
      assert.throws(() => assignmentInput({ ...input, behaviourSteps: { ...behaviourSteps, [step]: value } }, "Teacher"),
        /Select at least one behaviour step/);
    }
  }
  assert.throws(() => assignmentInput({ ...input, behaviourSteps: { ...behaviourSteps, none: true } }, "Teacher"),
    /Select None of the above on its own/);
  for (const steps of [behaviourSteps, { ...noSteps, chance: true }, { ...noSteps, choice: true }, { ...noSteps, consequence: true }, { ...noSteps, none: true }]) {
    assert.deepEqual(assignmentInput({ ...input, behaviourSteps: steps }, "Teacher").behaviourSteps, steps);
  }
  const legacy = { chance: true, choice: true, consequence: true };
  assert.deepEqual(assignmentInput({ ...input, behaviourSteps: legacy }, "Teacher").behaviourSteps, behaviourSteps);
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
