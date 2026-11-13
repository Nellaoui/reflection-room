import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "@/app/lib/reflection-reasons" ? new URL("./reflection-reasons.ts", import.meta.url).href : specifier, context);
  },
});
const { assignmentInput, attendanceInput, rosterInput, validDate, userCreateInput, userPatchInput } = await import("./reflection-validation.ts");
hooks.deregister();

const behaviourSteps = { chance: true, choice: true, consequence: true, none: false };
const assignment = { studentIds: ["pupil-1"], slots: ["lunch"], date: "2026-10-22", reasonCategory: "disruption", behaviourSteps };

test("generic calendar dates reject rollovers without restricting history date filters", () => {
  assert.equal(validDate("2028-02-29"), "2028-02-29");
  assert.equal(validDate("2026-10-24"), "2026-10-24");
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-02", "tomorrow"]) {
    assert.throws(() => validDate(date));
  }
});

test("a student can receive lunch reflection and repeated IDs are deduplicated", () => {
  assert.deepEqual(assignmentInput({ ...assignment, studentIds: ["pupil-1", "pupil-1"], assignedBy: "" }, "A Teacher"), {
    studentIds: ["pupil-1"], slot: "lunch", date: "2026-10-22", reason: "Disruption in class", behaviourSteps, assignedBy: "A Teacher",
  });
  assert.throws(() => assignmentInput({ ...assignment, slots: ["afternoon"] }, "Teacher"), /lunch break only/);
});

test("new assignments require a known reason and visible details for Other", () => {
  for (const reasonCategory of [undefined, null, "", "unrecognised", 42, false, {}, []]) {
    assert.throws(() => assignmentInput({ ...assignment, reasonCategory, reason: "Forged free-text reason" }, "Teacher"), /Select a reason/);
  }
  const other = { ...assignment, reasonCategory: "other" };
  for (const reasonDetails of [undefined, null, "", " \t\n ", "\u00a0\u3000", "\u200b\u200c\u2060", "\ufe0f\u2800"]) {
    assert.throws(() => assignmentInput({ ...other, reasonDetails }, "Teacher"), /Other reason details is required/);
  }
  for (const reasonDetails of [42, false, {}, []]) {
    assert.throws(() => assignmentInput({ ...other, reasonDetails }, "Teacher"), /Other reason details must be text/);
  }
  assert.throws(() => assignmentInput({ ...other, reasonDetails: "x".repeat(994) }, "Teacher"), /993 characters/);
  assert.equal(assignmentInput({ ...other, reasonDetails: "  Ａ reminder\n to reflect. " }, "Teacher").reason, "Other: A reminder to reflect.");
  assert.equal(assignmentInput({ ...other, reasonDetails: "x".repeat(993) }, "Teacher").reason.length, 1000);
});

test("behaviour steps require all three or None with a visible explanation", () => {
  const noSteps = { chance: false, choice: false, consequence: false, none: false };
  const none = { ...noSteps, none: true };
  for (const steps of [undefined, null, [], true, {}, noSteps, { ...noSteps, chance: true }, { ...behaviourSteps, choice: false }]) {
    assert.throws(() => assignmentInput({ ...assignment, behaviourSteps: steps }, "Teacher"), /Select Choice, Chance and Consequence/);
  }
  for (const step of Object.keys(behaviourSteps)) {
    for (const value of [undefined, null, 1, "true"]) {
      assert.throws(() => assignmentInput({ ...assignment, behaviourSteps: { ...behaviourSteps, [step]: value } }, "Teacher"),
        /Select Choice, Chance and Consequence/);
    }
  }
  assert.throws(() => assignmentInput({ ...assignment, behaviourSteps: { ...none, choice: true, explanation: "Fixture explanation" } }, "Teacher"),
    /Select None of the above on its own/);
  for (const explanation of [undefined, null, "", " \t\n ", "\u200b\ufe0f\u2800"]) {
    assert.throws(() => assignmentInput({ ...assignment, behaviourSteps: { ...none, explanation } }, "Teacher"), /Explanation is required/);
  }
  for (const explanation of [42, false, {}, []]) {
    assert.throws(() => assignmentInput({ ...assignment, behaviourSteps: { ...none, explanation } }, "Teacher"), /Explanation must be text/);
  }
  assert.throws(() => assignmentInput({ ...assignment, behaviourSteps: { ...none, explanation: "x".repeat(1001) } }, "Teacher"), /1000 characters/);
  assert.deepEqual(assignmentInput(assignment, "Teacher").behaviourSteps, behaviourSteps);
  assert.deepEqual(assignmentInput({ ...assignment, behaviourSteps: { ...none, explanation: "  One\n reason. " } }, "Teacher").behaviourSteps,
    { ...none, explanation: "One reason." });
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
