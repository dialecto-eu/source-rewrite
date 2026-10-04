import { test } from "node:test";
import assert from "node:assert/strict";

import {
  offsetToLine,
  findOccurrences,
  resolveCandidate,
  applyEdits,
  applyCandidatesToFile,
} from "../src/apply.js";

// A small Elixir-ish file. Line numbers are 1-based:
//   1 defmodule Demo do
//   2   def render do
//   3     <%= gettext("Get started") %>
//   4   end
//   5 end
const FILE = [
  "defmodule Demo do",
  "  def render do",
  '    <%= gettext("Get started") %>',
  "  end",
  "end",
  "",
].join("\n");

const MATCH = '    <%= gettext("Get started") %>\n';
const REPLACEMENT = '    <%= gettext("Begin") %>\n';

function candidate(overrides = {}) {
  return {
    path: "lib/demo.ex",
    start_line: 3,
    end_line: 3,
    match: MATCH,
    replacement: REPLACEMENT,
    old_msgid: "Get started",
    new_msgid: "Begin",
    ...overrides,
  };
}

test("offsetToLine maps byte offsets to 1-based line numbers", () => {
  assert.equal(offsetToLine(FILE, 0), 1);
  assert.equal(offsetToLine(FILE, FILE.indexOf("gettext")), 3);
});

test("findOccurrences finds all non-overlapping matches", () => {
  assert.deepEqual(findOccurrences("a.b.a.b", "a.b"), [0, 4]);
  assert.deepEqual(findOccurrences("xxx", "y"), []);
  assert.deepEqual(findOccurrences("anything", ""), []);
});

test("applyEdits splices non-overlapping edits in order", () => {
  const out = applyEdits("0123456789", [
    { offset: 1, length: 2, replacement: "X" }, // replaces "12"
    { offset: 5, length: 1, replacement: "Y" }, // replaces "5"
  ]);
  assert.equal(out, "0X34Y6789");
});

test("clean apply: match sits exactly on start_line", () => {
  const r = applyCandidatesToFile(FILE, [candidate()]);
  assert.equal(r.changed, true);
  assert.equal(r.applied.length, 1);
  assert.equal(r.skipped.length, 0);
  assert.ok(r.content.includes('gettext("Begin")'));
  assert.ok(!r.content.includes('gettext("Get started")'));
  // The rest of the file is byte-identical (minimal diff).
  assert.ok(r.content.startsWith("defmodule Demo do\n  def render do\n"));
  assert.ok(r.content.endsWith("  end\nend\n"));
});

test("drifted apply: the call moved but is within the window", () => {
  // Insert 3 lines at the top so the call is now on line 6, while the candidate
  // still claims start_line 3.
  const drifted = "# added\n# added\n# added\n" + FILE;
  const r = applyCandidatesToFile(drifted, [candidate({ start_line: 3 })], { window: 25 });
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].drift, 3);
  assert.ok(r.content.includes('gettext("Begin")'));
});

test("missing match => skipped (not_found), file unchanged", () => {
  const other = 'defmodule Demo do\n  def render do\n    <%= gettext("Something else") %>\n  end\nend\n';
  const r = applyCandidatesToFile(other, [candidate()]);
  assert.equal(r.changed, false);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, "not_found");
  assert.equal(r.content, other);
});

test("ambiguous match within window => skipped (never guess)", () => {
  // The same call appears on lines 3 and 4; the candidate anchors at line 5
  // (neither exact line), so both are equidistant-ish and in-window => ambiguous.
  const dup = [
    "defmodule Demo do",
    "  def render do",
    '    <%= gettext("Get started") %>',
    '    <%= gettext("Get started") %>',
    "  end",
    "end",
    "",
  ].join("\n");
  const r = applyCandidatesToFile(dup, [candidate({ start_line: 6 })], { window: 25 });
  assert.equal(r.changed, false);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, "ambiguous");
});

test("duplicate bytes but an exact anchor line => applied at the anchor only", () => {
  // Same call on lines 3 and 4; candidate anchors exactly on line 4 — unambiguous
  // even though the bytes also appear on line 3. Only line 4 is rewritten.
  const dup = [
    "defmodule Demo do",
    "  def render do",
    '    <%= gettext("Get started") %>',
    '    <%= gettext("Get started") %>',
    "  end",
    "end",
    "",
  ].join("\n");
  const r = applyCandidatesToFile(dup, [candidate({ start_line: 4 })]);
  assert.equal(r.applied.length, 1);
  // Line 3 keeps the old call; line 4 gets the new one.
  const lines = r.content.split("\n");
  assert.equal(lines[2], '    <%= gettext("Get started") %>');
  assert.equal(lines[3], '    <%= gettext("Begin") %>');
});

test("match exists but only far outside the window => skipped (out_of_window)", () => {
  const drifted = "# pad\n".repeat(100) + FILE; // call now ~line 103
  const r = applyCandidatesToFile(drifted, [candidate({ start_line: 3 })], { window: 25 });
  assert.equal(r.changed, false);
  assert.equal(r.skipped[0].reason, "out_of_window");
});

test("multiple candidates in one file all apply (resolved against original)", () => {
  const file = [
    "defmodule Demo do",
    '  @a gettext("Get started")',
    '  @b gettext("Sign out")',
    "end",
    "",
  ].join("\n");

  const c1 = candidate({
    start_line: 2,
    match: '  @a gettext("Get started")\n',
    replacement: '  @a gettext("Begin")\n',
  });
  const c2 = candidate({
    start_line: 3,
    old_msgid: "Sign out",
    new_msgid: "Log out",
    match: '  @b gettext("Sign out")\n',
    replacement: '  @b gettext("Log out")\n',
  });

  const r = applyCandidatesToFile(file, [c1, c2]);
  assert.equal(r.applied.length, 2);
  assert.equal(r.skipped.length, 0);
  assert.ok(r.content.includes('gettext("Begin")'));
  assert.ok(r.content.includes('gettext("Log out")'));
});

test("no candidates => no-op, unchanged content", () => {
  const r = applyCandidatesToFile(FILE, []);
  assert.equal(r.changed, false);
  assert.equal(r.content, FILE);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 0);
});

test("candidate without a replacement is skipped (no_replacement)", () => {
  const r = resolveCandidate(FILE, candidate({ replacement: undefined }));
  assert.equal(r.status, "skipped");
  assert.equal(r.reason, "no_replacement");
});

test("resolveCandidate with no start_line: unique match resolves, duplicate is ambiguous", () => {
  const unique = resolveCandidate(FILE, candidate({ start_line: null }));
  assert.equal(unique.status, "resolved");

  const dup = '    <%= gettext("Get started") %>\n    <%= gettext("Get started") %>\n';
  const ambiguous = resolveCandidate(dup, candidate({ start_line: null }));
  assert.equal(ambiguous.status, "skipped");
  assert.equal(ambiguous.reason, "ambiguous");
});
