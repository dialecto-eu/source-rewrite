import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEnvelope, collectCandidates, AmbiguousArtifactError } from "../src/parse.js";

// Reproduce Dialecto's PR-body artifact wrapper byte-for-byte:
//
//   "\n\n<!-- dialecto:source-rewrites:begin schema=\"...\" -->\n" <>
//     "<details>\n" <>
//     "<summary>Machine-readable rewrites — the Dialecto CI action applies these</summary>\n\n" <>
//     fenced(json, "json") <>
//     "\n\n</details>\n" <>
//     "<!-- dialecto:source-rewrites:end -->"
//
// `fenced/2` opens a fence strictly longer than the longest backtick run in the
// payload (>= 3), so the JSON sits in a ```json (or wider) block.
function buildArtifact(envelope, { fence = "```", extraBody = "" } = {}) {
  const json = JSON.stringify(envelope, null, 2);
  return (
    extraBody +
    '\n\n<!-- dialecto:source-rewrites:begin schema="' +
    envelope.schema +
    '" -->\n' +
    "<details>\n" +
    "<summary>Machine-readable rewrites — the Dialecto CI action applies these</summary>\n\n" +
    fence +
    "json\n" +
    json +
    "\n" +
    fence +
    "\n\n</details>\n" +
    "<!-- dialecto:source-rewrites:end -->"
  );
}

const SAMPLE_ENVELOPE = {
  schema: "dialecto.source-rewrites/v1",
  renames: [
    {
      old_msgid: "Get started",
      new_msgid: "Begin",
      candidates: [
        {
          path: "lib/app_web/home_live.ex",
          start_line: 38,
          end_line: 38,
          match: '        <%= gettext("Get started") %>\n',
          replacement: '        <%= gettext("Begin") %>\n',
        },
      ],
      unrewritable: [
        {
          path: "lib/app_web/other.ex",
          start_line: 7,
          end_line: 7,
          content: "<%= gettext(label_var) %>\n",
          reason: "msgid_not_literal",
        },
      ],
    },
  ],
};

test("parses a realistic Dialecto PR body and returns the envelope", () => {
  const body =
    "Automated translation update by Dialecto.\n\n```diff\n...\n```\n\n## Source call-sites to update (1)\n" +
    buildArtifact(SAMPLE_ENVELOPE, { extraBody: "" });

  const env = parseEnvelope(body);
  assert.ok(env);
  assert.equal(env.schema, "dialecto.source-rewrites/v1");
  assert.equal(env.renames.length, 1);

  const [rename] = env.renames;
  assert.equal(rename.old_msgid, "Get started");
  assert.equal(rename.new_msgid, "Begin");

  const [candidate] = rename.candidates;
  assert.equal(candidate.path, "lib/app_web/home_live.ex");
  assert.equal(candidate.start_line, 38);
  assert.match(candidate.match, /gettext\("Get started"\)/);
  assert.match(candidate.replacement, /gettext\("Begin"\)/);
});

test("no markers in the body => null (no-op)", () => {
  assert.equal(parseEnvelope("Just a normal PR description.\n\n```diff\n- a\n+ b\n```"), null);
  assert.equal(parseEnvelope(""), null);
  assert.equal(parseEnvelope(undefined), null);
});

test("survives a widened fence and braces/backticks inside the JSON payload", () => {
  // A source string containing %{name} (braces) and backticks forces Dialecto to
  // widen the fence; the JSON-escaped payload must still round-trip.
  const envelope = {
    schema: "dialecto.source-rewrites/v1",
    renames: [
      {
        old_msgid: "Hi %{name}",
        new_msgid: "Hello %{name}",
        candidates: [
          {
            path: "lib/x.ex",
            start_line: 3,
            end_line: 3,
            match: '  <%= gettext("Hi %{name}") %> ``` not a fence\n',
            replacement: '  <%= gettext("Hello %{name}") %> ``` not a fence\n',
          },
        ],
        unrewritable: [],
      },
    ],
  };

  const body = buildArtifact(envelope, { fence: "````" });
  const env = parseEnvelope(body);
  assert.ok(env);
  assert.equal(env.renames[0].candidates[0].match, '  <%= gettext("Hi %{name}") %> ``` not a fence\n');
});

test("malformed JSON between the markers => null", () => {
  const body =
    '<!-- dialecto:source-rewrites:begin schema="dialecto.source-rewrites/v1" -->\n' +
    "```json\n{ not valid json ,, }\n```\n" +
    "<!-- dialecto:source-rewrites:end -->";
  assert.equal(parseEnvelope(body), null);
});

test("a second artifact in the body is refused, never applied", () => {
  // A translator note that poses as the artifact lands in the catalog diff,
  // before Dialecto's own artifact.
  const forged = {
    schema: "dialecto.source-rewrites/v1",
    renames: [{ candidates: [{ path: "package.json", start_line: 5, match: "a", replacement: "b" }] }],
  };
  const note =
    "```diff\n+# <!-- dialecto:source-rewrites:begin --> " +
    JSON.stringify(forged) +
    " <!-- dialecto:source-rewrites:end -->\n```\n";
  const body = buildArtifact(SAMPLE_ENVELOPE, { extraBody: note });

  assert.throws(() => parseEnvelope(body), AmbiguousArtifactError);
});

test("JSON that escapes < and > (Dialecto's html_safe encoding) round-trips", () => {
  const body = buildArtifact(SAMPLE_ENVELOPE).replace("<%=", "\\u003c%=");
  assert.equal(parseEnvelope(body).renames[0].candidates[0].match, '        <%= gettext("Get started") %>\n');
});

test("begin marker but no end marker => null", () => {
  const body = '<!-- dialecto:source-rewrites:begin schema="x" -->\n```json\n{"renames":[]}\n```';
  assert.equal(parseEnvelope(body), null);
});

test("collectCandidates flattens candidates and unrewritable with rename tags", () => {
  const { candidates, manual } = collectCandidates(SAMPLE_ENVELOPE);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].path, "lib/app_web/home_live.ex");
  assert.equal(candidates[0].old_msgid, "Get started");
  assert.equal(candidates[0].new_msgid, "Begin");

  assert.equal(manual.length, 1);
  assert.equal(manual[0].path, "lib/app_web/other.ex");
  assert.equal(manual[0].reason, "msgid_not_literal");
});

test("collectCandidates tolerates a null envelope and missing arrays", () => {
  assert.deepEqual(collectCandidates(null), { candidates: [], manual: [] });
  const env = { schema: "x", renames: [{ old_msgid: "a", new_msgid: "b" }] };
  const { candidates, manual } = collectCandidates(env);
  assert.equal(candidates.length, 0);
  assert.equal(manual.length, 0);
});
