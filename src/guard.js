// What the action is allowed to touch, and for whom it runs.
//
// The rewrites come from a pull request body, and the job that applies them can
// push to the branch, so the body is treated as untrusted input: a rewrite may
// only edit an existing regular file inside the checkout, never git's own
// metadata or CI configuration (a crafted `.git/config` or workflow edit would
// run code with the job's token), and only on a pull request that Dialecto could
// have opened.

import fs from "node:fs";
import path from "node:path";

// Why `relPath` may not be edited under `workspace`, or null when it may.
// Reasons: "bad_path", "path_escape", "protected_path", "file_missing",
// "symlink", "not_a_file".
export function pathRefusal(workspace, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\0")) {
    return "bad_path";
  }
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) return "path_escape";

  const segments = relPath.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return "bad_path";
  if (segments.includes("..")) return "path_escape";
  // Case-insensitively: macOS and Windows checkouts resolve `.GIT` to `.git`.
  if (segments.some((s) => s.toLowerCase() === ".git")) return "protected_path";
  if (segments[0].toLowerCase() === ".github") return "protected_path";

  const root = path.resolve(workspace);
  const absPath = path.resolve(root, ...segments);
  if (!absPath.startsWith(root + path.sep)) return "path_escape";

  let stat;
  try {
    stat = fs.lstatSync(absPath);
  } catch {
    return "file_missing";
  }
  if (stat.isSymbolicLink()) return "symlink";
  if (!stat.isFile()) return "not_a_file";

  // A symlinked parent directory could still lead outside the checkout.
  const realRoot = fs.realpathSync(root);
  if (!fs.realpathSync(absPath).startsWith(realRoot + path.sep)) return "path_escape";

  return null;
}

// Why the rewrites of `pr` (the event's `pull_request`) may not be applied, or
// null when they may. A fork's author controls its body and its branch can't be
// pushed; Dialecto opens its pull requests from the same repository, on a
// branch starting with `branchPrefix`, and, when the workflow names them, as
// one of `allowedAuthors`.
// Reasons: "no_pull_request", "fork", "branch", "author".
export function pullRequestRefusal(pr, { branchPrefix = "", allowedAuthors = [] } = {}) {
  if (!pr || typeof pr !== "object") return "no_pull_request";

  const head = pr.head?.repo?.full_name;
  const base = pr.base?.repo?.full_name;
  if (!head || head !== base) return "fork";

  if (branchPrefix && !String(pr.head?.ref ?? "").startsWith(branchPrefix)) return "branch";
  if (allowedAuthors.length > 0 && !allowedAuthors.includes(pr.user?.login)) return "author";

  return null;
}

// `text` safe inside a Markdown inline code span (paths come from the body).
export function inlineCode(text) {
  return "`" + String(text).replace(/[`\r\n]/g, "'") + "`";
}
