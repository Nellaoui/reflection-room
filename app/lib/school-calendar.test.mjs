import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const fixtureCalendar = {
  campus: "Fixture school", academicYear: "2026–2027",
  startDate: "2026-09-01", endDate: "2027-06-30", closedWeekdays: [0, 6],
  closures: [
    { start: "2026-10-26", end: "2026-10-30", label: "Fixture half term" },
    { start: "2026-12-21", end: "2027-01-01", label: "Fixture winter holiday" },
  ],
  source: { url: "https://example.invalid/test-calendar", verifiedAt: "2026-11-04" },
};
const compiled = ts.transpileModule(readFileSync(new URL("./school-calendar.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(name => name === "./casa-school-calendar.json" ? fixtureCalendar : require(name), loaded, loaded.exports);
const { schoolDayClosure, isSchoolDay, nextSchoolDay } = loaded.exports;

test("school holidays are inclusive and weekends are unavailable", () => {
  assert.equal(schoolDayClosure("2026-10-23"), null);
  for (const date of ["2026-10-26", "2026-10-28", "2026-10-30"]) assert.match(schoolDayClosure(date), /Fixture half term/);
  for (const date of ["2026-10-24", "2026-10-25", "2026-10-31", "2026-11-01"]) assert.match(schoolDayClosure(date), /weekends/);
  assert.equal(isSchoolDay("2026-11-02"), true);
  for (const date of ["2026-12-21", "2026-12-31", "2027-01-01"]) assert.match(schoolDayClosure(date), /Fixture winter holiday/);
});

test("next school day skips a complete holiday and adjoining weekends in both directions", () => {
  assert.equal(nextSchoolDay("2026-10-23"), "2026-11-02");
  assert.equal(nextSchoolDay("2026-10-28", 1, true), "2026-11-02");
  assert.equal(nextSchoolDay("2026-11-02", -1), "2026-10-23");
  assert.equal(nextSchoolDay("2026-11-02", 1, true), "2026-11-02");
  assert.equal(nextSchoolDay("2026-12-18"), "2027-01-04");
});

test("unverified dates and invalid date strings fail closed", () => {
  for (const date of ["2026-08-31", "2027-07-01"]) {
    assert.match(schoolDayClosure(date), /outside the verified school calendar/);
    assert.equal(isSchoolDay(date), false);
  }
  for (const date of ["", "tomorrow", "2026-02-29", "2026-11-31", "2026-1-02"]) {
    assert.match(schoolDayClosure(date), /valid calendar date/);
    assert.equal(nextSchoolDay(date), null);
  }
  assert.equal(schoolDayClosure("2026-09-01"), null);
  assert.equal(schoolDayClosure("2027-06-30"), null);
});

test("search ends at coverage bounds and handles fully closed calendars without looping", () => {
  assert.equal(nextSchoolDay("2027-06-30"), null);
  assert.equal(nextSchoolDay("2026-09-01", -1), null);
  assert.equal(nextSchoolDay("2026-08-01"), "2026-09-01");
  assert.equal(nextSchoolDay("2027-08-01", -1), "2027-06-30");
  assert.equal(nextSchoolDay("2026-10-22", 1, true, { ...fixtureCalendar, closedWeekdays: [0, 1, 2, 3, 4, 5, 6] }), null);
});

test("invalid source configuration never enables scheduling", () => {
  for (const calendar of [
    { ...fixtureCalendar, startDate: "invalid" },
    { ...fixtureCalendar, endDate: "2026-08-31" },
    { ...fixtureCalendar, closedWeekdays: [7] },
    { ...fixtureCalendar, closures: [{ start: "2026-11-02", end: "2026-11-01", label: "Invalid" }] },
    { ...fixtureCalendar, closures: [{ start: "2026-10-26", end: "2026-10-30", label: " " }] },
  ]) {
    assert.match(schoolDayClosure("2026-10-22", calendar), /calendar is unavailable/);
    assert.equal(nextSchoolDay("2026-10-22", 1, true, calendar), null);
  }
});
