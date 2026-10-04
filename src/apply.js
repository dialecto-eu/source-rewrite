// Re-anchor and apply Dialecto's computed call-site rewrites against real source.
//
// Dialecto captured each call-site's exact bytes during a scan (the `match`) at a
// known `path:start_line`, and computed the rewritten bytes (the `replacement`).
// The source may have drifted since the scan (lines added/removed above, the call
// moved), so we DON'T trust start_line blindly: we locate the `match` bytes and
// use start_line only to disambiguate. The guiding rule is "never apply a wrong
// edit" — when we can't anchor a candidate uniquely and safely, we SKIP it.

export const DEFAULT_WINDOW = 25;

// 1-based line number of a byte offset (the line the offset begins on).
export function offsetToLine(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// Every offset where `needle` occurs in `haystack`, scanning non-overlapping
// (advance past each hit) so two identical adjacent call-sites both register.
export function findOccurrences(haystack, needle) {
  const offsets = [];
  if (!needle) return offsets;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + needle.length;
  }
  return offsets;
}

// Resolve one candidate to a concrete edit position against `content`, or decide
// it can't be applied safely. Returns either
//   { status: "resolved", offset, length, line, drift }
// or
//   { status: "skipped", reason }
//
// Reasons: "no_replacement" (not a real candidate), "empty_match",
// "not_found" (the bytes are gone — already applied, or the call was removed),
// "out_of_window" (the only match is far from start_line — too risky to trust),
// "ambiguous" (the match appears more than once where we'd anchor — could pick
// the wrong one).
export function resolveCandidate(content, candidate, window = DEFAULT_WINDOW) {
  const { match, replacement, start_line } = candidate;

  if (typeof replacement !== "string") return { status: "skipped", reason: "no_replacement" };
  if (typeof match !== "string" || match.length === 0) {
    return { status: "skipped", reason: "empty_match" };
  }

  const offsets = findOccurrences(content, match);
  if (offsets.length === 0) return { status: "skipped", reason: "not_found" };

  const hits = offsets.map((offset) => ({ offset, line: offsetToLine(content, offset) }));

  // No anchor line to lean on: only safe when the match is globally unique.
  if (typeof start_line !== "number") {
    if (hits.length === 1) {
      return { status: "resolved", offset: hits[0].offset, length: match.length, line: hits[0].line, drift: null };
    }
    return { status: "skipped", reason: "ambiguous" };
  }

  // Exact anchor: a single occurrence sitting on start_line is unambiguous even
  // if the same bytes appear elsewhere — we have a precise line to commit to.
  const exact = hits.filter((h) => h.line === start_line);
  if (exact.length === 1) {
    return { status: "resolved", offset: exact[0].offset, length: match.length, line: exact[0].line, drift: 0 };
  }
  if (exact.length > 1) return { status: "skipped", reason: "ambiguous" };

  // Drift: nothing on the exact line, so accept the match only if exactly one
  // occurrence falls inside the window around start_line. Zero in-window ⇒ the
  // match is too far to trust; two-or-more ⇒ we can't tell which is the call.
  const within = hits.filter((h) => Math.abs(h.line - start_line) <= window);
  if (within.length === 1) {
    return { status: "resolved", offset: within[0].offset, length: match.length, line: within[0].line, drift: within[0].line - start_line };
  }
  if (within.length === 0) return { status: "skipped", reason: "out_of_window" };
  return { status: "skipped", reason: "ambiguous" };
}

// Splice a set of non-overlapping edits into `content`. Each edit is
// { offset, length, replacement }; edits must be sorted ascending by offset.
export function applyEdits(content, edits) {
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += content.slice(cursor, e.offset);
    out += e.replacement;
    cursor = e.offset + e.length;
  }
  out += content.slice(cursor);
  return out;
}

// Apply every candidate targeting one file's `content`. All candidates are
// resolved against the SAME original content first (so one edit can't shift the
// anchor of the next), then applied bottom-to-top. Two candidates that resolve
// to overlapping spans can't both be trusted, so the later one is skipped as a
// conflict. Returns { content, applied, skipped, changed }.
export function applyCandidatesToFile(content, candidates, opts = {}) {
  const window = opts.window ?? DEFAULT_WINDOW;
  const resolved = [];
  const skipped = [];

  for (const candidate of candidates) {
    const r = resolveCandidate(content, candidate, window);
    if (r.status === "resolved") {
      resolved.push({ candidate, offset: r.offset, length: r.length, line: r.line, drift: r.drift });
    } else {
      skipped.push({ candidate, reason: r.reason });
    }
  }

  resolved.sort((a, b) => a.offset - b.offset);

  const edits = [];
  const applied = [];
  let prevEnd = -1;
  for (const r of resolved) {
    if (r.offset < prevEnd) {
      // Overlaps an already-accepted edit — refuse rather than corrupt the file.
      skipped.push({ candidate: r.candidate, reason: "conflict" });
      continue;
    }
    edits.push({ offset: r.offset, length: r.length, replacement: r.candidate.replacement });
    applied.push({ candidate: r.candidate, line: r.line, drift: r.drift });
    prevEnd = r.offset + r.length;
  }

  const newContent = applyEdits(content, edits);
  return { content: newContent, applied, skipped, changed: newContent !== content };
}
