// Parse the machine-readable source-rewrites artifact out of a Dialecto PR body.
//
// Dialecto embeds a schema-versioned JSON envelope between stable HTML-comment sentinels
// so the repo-side action can grep for it with no markdown parser:
//
//   <!-- dialecto:source-rewrites:begin schema="dialecto.source-rewrites/v1" -->
//   <details>
//   <summary>Machine-readable rewrites — the Dialecto CI action applies these</summary>
//
//   ```json
//   { "schema": "dialecto.source-rewrites/v1", "renames": [ ... ] }
//   ```
//
//   </details>
//   <!-- dialecto:source-rewrites:end -->
//
// The envelope shape:
//
//   { schema, renames: [
//       { old_msgid, new_msgid,
//         candidates:   [ { path, start_line, end_line, match, replacement } ],
//         unrewritable: [ { path, start_line, end_line, content, reason } ] } ] }
//
// candidates are the sites Dialecto computed a safe rewrite for (apply these);
// unrewritable are sites it refused to touch (surface them for a human).

// The begin sentinel carries a schema="..." attribute that may evolve, so we
// anchor on the stable prefix up to the closing `-->`, not the exact attribute.
const BEGIN_PREFIX = "<!-- dialecto:source-rewrites:begin";
const END_MARKER = "<!-- dialecto:source-rewrites:end -->";

export const EXPECTED_SCHEMA_PREFIX = "dialecto.source-rewrites/";

// Dialecto writes exactly one artifact and breaks the sentinel in every other
// byte of the body (translator notes, msgids, scanned paths). A second begin
// sentinel therefore came from text Dialecto didn't write, and neither artifact
// can be trusted: the action refuses rather than guess which one is real.
export class AmbiguousArtifactError extends Error {
  constructor() {
    super("the pull request body holds more than one rewrites artifact");
    this.name = "AmbiguousArtifactError";
  }
}

// Pull the JSON envelope out of a PR body. Returns the parsed envelope object,
// or null when the body carries no artifact (a translation-only PR, or any PR
// that isn't a Dialecto rename) — null means "nothing to do", never an error.
// Throws AmbiguousArtifactError when the body holds more than one.
export function parseEnvelope(body) {
  if (typeof body !== "string" || body.length === 0) return null;

  const beginAt = body.indexOf(BEGIN_PREFIX);
  if (beginAt === -1) return null;
  if (body.indexOf(BEGIN_PREFIX, beginAt + BEGIN_PREFIX.length) !== -1) {
    throw new AmbiguousArtifactError();
  }

  // The begin sentinel ends at its own `-->`; the artifact region runs from
  // there up to the end sentinel. Searching for the end AFTER the begin keeps a
  // stray ":end" string elsewhere in the body from terminating us early.
  const beginEnd = body.indexOf("-->", beginAt);
  if (beginEnd === -1) return null;
  const endAt = body.indexOf(END_MARKER, beginEnd);
  if (endAt === -1) return null;

  const region = body.slice(beginEnd + 3, endAt);

  // The envelope is the only brace-delimited object in the region: the <details>
  // / <summary> wrapper and the (possibly widened) code fence contain no braces,
  // and JSON string contents like "%{name}" are bracketed by the envelope's own
  // outer braces. So first-`{` .. last-`}` isolates the JSON without depending on
  // the fence width (Dialecto widens the fence when the payload holds backticks).
  const jsonStart = region.indexOf("{");
  const jsonEnd = region.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) return null;

  const json = region.slice(jsonStart, jsonEnd + 1);

  let envelope;
  try {
    envelope = JSON.parse(json);
  } catch {
    return null;
  }

  if (!envelope || !Array.isArray(envelope.renames)) return null;
  return envelope;
}

// Flatten an envelope into a flat list of apply candidates and a flat list of
// manual (unrewritable) sites, each tagged with the rename it came from so the
// summary can explain the edit. A missing/empty field degrades to [] rather than
// throwing — we never want a malformed entry to abort the whole batch.
export function collectCandidates(envelope) {
  const candidates = [];
  const manual = [];
  if (!envelope) return { candidates, manual };

  for (const rename of envelope.renames ?? []) {
    const tag = { old_msgid: rename?.old_msgid, new_msgid: rename?.new_msgid };

    for (const c of rename?.candidates ?? []) {
      candidates.push({
        path: c?.path,
        start_line: c?.start_line ?? null,
        end_line: c?.end_line ?? null,
        match: c?.match,
        replacement: c?.replacement,
        ...tag,
      });
    }

    for (const u of rename?.unrewritable ?? []) {
      manual.push({
        path: u?.path,
        start_line: u?.start_line ?? null,
        end_line: u?.end_line ?? null,
        content: u?.content,
        reason: u?.reason,
        ...tag,
      });
    }
  }

  return { candidates, manual };
}
