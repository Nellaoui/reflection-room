import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../components/ReflectionWorkspace.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ReflectionWorkspace.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const parser = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "parseCsv");
assert.ok(parser, "The production CSV parser is present.");
const compiled = ts.transpileModule(parser.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const parseCsv = new Function(`${compiled}\nreturn parseCsv;`)();
const exportFunctions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ["directoryCsvRows", "csvCell"].includes(node.name?.text));
const exportCompiled = ts.transpileModule(exportFunctions.map(node => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const { directoryCsvRows, csvCell } = new Function(`${exportCompiled}\nreturn {directoryCsvRows,csvCell};`)();

test("generic Name Grade Class CSV retains the existing three-field behavior", () => {
  assert.deepEqual(parseCsv('Name,Grade,Class\n"Test, Pupil",Year 3,3A\n'), [{ name: "Test, Pupil", grade: "Year 3", className: "3A" }]);
});

test("optional Toddle ID stays an exact string and preserves otherwise identical profiles", () => {
  const rows = parseCsv('Name,Grade,Class,Toddle ID\nIdentical Test Name,Year 3,Class to confirm,123456789012345678\nIdentical Test Name,Year 3,Class to confirm,123456789012345679\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].toddleId, "123456789012345678");
  assert.equal(rows[1].toddleId, "123456789012345679");
});

test("directory CSV export and reimport preserve stable identities and generic headers", () => {
  const pupils = ["123456789012345678", "123456789012345679"].map((toddleId, index) => ({ id: `test-${index}`, name: "Identical Test Name", grade: "Year 3", className: "Class to confirm", toddleId }));
  const csv = directoryCsvRows(pupils).map(row => row.map(csvCell).join(",")).join("\n");
  assert.deepEqual(parseCsv(csv), pupils.map(({ id, ...pupil }) => { void id; return pupil; }));
  assert.deepEqual(directoryCsvRows([{ name: "Generic Pupil", grade: "Year 3", className: "3A" }])[0], ["Name", "Grade", "Class"]);
});
