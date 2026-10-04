// Entry point for the Dialecto Source Rewrite GitHub Action.
//
// Reads the PR body from the event payload, parses Dialecto's machine-readable
// rewrites artifact, re-anchors each candidate against the checked-out source,
// applies the safe ones, and reports applied/skipped. Committing back to the PR
// branch is OPT-IN (the `commit` input); by default the action only edits the
// working tree and a later workflow step commits.
//
// Dependency-light by design: only Node built-ins (node:fs, node:path,
// node:child_process) and the GitHub-provided env (GITHUB_*, GITHUB_EVENT_PATH).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  parseEnvelope,
  collectCandidates,
  AmbiguousArtifactError,
  EXPECTED_SCHEMA_PREFIX,
} from "./src/parse.js";
import { applyCandidatesToFile, DEFAULT_WINDOW } from "./src/apply.js";
import { pathRefusal, pullRequestRefusal, inlineCode } from "./src/guard.js";

// Read an action input the same way @actions/core does: INPUT_<NAME> with spaces
// turned into underscores and the whole thing upper-cased. We also accept a
// hyphens-to-underscores fallback for runners that don't preserve hyphens.
function getInput(name) {
  const upper = name.replace(/ /g, "_").toUpperCase();
  return (
    process.env[`INPUT_${upper}`] ??
    process.env[`INPUT_${upper.replace(/-/g, "_")}`] ??
    ""
  ).trim();
}

function getBool(name, fallback = false) {
  const v = getInput(name).toLowerCase();
  if (v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function log(msg) {
  process.stdout.write(msg + "\n");
}

// GitHub Actions output/summary plumbing via the file-based protocol (no SDK).
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const v = String(value);
  // Multiline values use the random-delimiter heredoc form.
  if (v.includes("\n")) {
    const delim = `__dialecto_${Math.random().toString(36).slice(2)}__`;
    fs.appendFileSync(file, `${name}<<${delim}\n${v}\n${delim}\n`);
  } else {
    fs.appendFileSync(file, `${name}=${v}\n`);
  }
}

function appendSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, md + "\n");
}

// The PR body to parse and the pull request it came from: an explicit `pr-body`
// input wins (handy for testing and re-runs; the workflow author vouches for
// it), otherwise the pull_request event payload.
function resolvePullRequest() {
  const override = getInput("pr-body");
  if (override) return { body: override, pr: null, overridden: true };

  const eventPath = getInput("event-path") || process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return { body: null, pr: null, overridden: false };

  try {
    const pr = JSON.parse(fs.readFileSync(eventPath, "utf8"))?.pull_request ?? null;
    return { body: pr?.body ?? null, pr, overridden: false };
  } catch {
    return { body: null, pr: null, overridden: false };
  }
}

function listInput(name) {
  return getInput(name)
    .split(/[\s,]+/)
    .filter((s) => s !== "");
}

function resolveWorkspace() {
  return path.resolve(getInput("working-directory") || process.env.GITHUB_WORKSPACE || process.cwd());
}

// Group flat candidates by file path, preserving order within each file.
function groupByPath(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    const key = c.path;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return groups;
}

function describe(c) {
  return `${c.path}:${c.start_line ?? "?"} (${JSON.stringify(c.old_msgid)} → ${JSON.stringify(c.new_msgid)})`;
}

function commitChanges(workspace, files, message) {
  const git = (args) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" }).toString().trim();

  // Identify as the action so the commit is attributable; harmless if a global
  // identity already exists.
  try {
    git(["config", "user.name", "dialecto-source-rewrite[bot]"]);
    git(["config", "user.email", "dialecto-source-rewrite@users.noreply.github.com"]);
  } catch {
    /* non-fatal: a pre-configured identity is fine */
  }

  git(["add", "--", ...files]);

  // Nothing staged (e.g. an identical re-run) ⇒ skip the commit quietly.
  const status = git(["status", "--porcelain"]);
  if (status === "") {
    log("Nothing to commit (working tree already matches).");
    return false;
  }

  // --no-verify: hooks are code from the branch (husky and the like install them
  // during `npm ci`), and this commit is a mechanical edit in a job that can push.
  git(["commit", "--no-verify", "-m", message]);
  git(["push"]);
  log("Committed and pushed the applied rewrites.");
  return true;
}

function main() {
  const dryRun = getBool("dry-run", false);
  const doCommit = getBool("commit", false);
  const failOnSkip = getBool("fail-on-skip", false);
  const window = Number.parseInt(getInput("anchor-window"), 10) || DEFAULT_WINDOW;
  const commitMessage = getInput("commit-message") || "Apply Dialecto source call-site rewrites";
  const workspace = resolveWorkspace();

  const { body, pr, overridden } = resolvePullRequest();

  let envelope;
  try {
    envelope = parseEnvelope(body);
  } catch (error) {
    if (!(error instanceof AmbiguousArtifactError)) throw error;
    log(`Refusing to apply rewrites: ${error.message}.`);
    appendSummary(`### Dialecto source rewrites\n\nRefused: ${error.message}. Nothing was changed.`);
    setOutput("applied-count", 0);
    setOutput("skipped-count", 0);
    setOutput("changed-files", "");
    return 1;
  }

  if (!envelope) {
    log("No Dialecto source-rewrites artifact found in the PR body — nothing to do.");
    setOutput("applied-count", 0);
    setOutput("skipped-count", 0);
    setOutput("changed-files", "");
    appendSummary("### Dialecto source rewrites\n\nNo rewrites artifact in this PR — nothing to apply.");
    return 0;
  }

  // A rewrites artifact in a pull request Dialecto couldn't have opened is
  // refused loudly: its body is someone else's input to a job that can push.
  if (!overridden) {
    const refusal = pullRequestRefusal(pr, {
      branchPrefix: getInput("branch-prefix"),
      allowedAuthors: listInput("allowed-authors"),
    });
    if (refusal) {
      const why = {
        no_pull_request: "this run has no pull request to read",
        fork: "the pull request comes from a fork",
        branch: `the pull request's branch doesn't start with "${getInput("branch-prefix")}"`,
        author: `the pull request's author isn't in allowed-authors`,
      }[refusal];
      log(`Refusing to apply rewrites: ${why}.`);
      appendSummary(`### Dialecto source rewrites\n\nRefused: ${why}. Nothing was changed.`);
      setOutput("applied-count", 0);
      setOutput("skipped-count", 0);
      setOutput("changed-files", "");
      return 1;
    }
  }

  if (typeof envelope.schema === "string" && !envelope.schema.startsWith(EXPECTED_SCHEMA_PREFIX)) {
    log(`Warning: unexpected artifact schema "${envelope.schema}" (expected "${EXPECTED_SCHEMA_PREFIX}*"). Proceeding.`);
  }

  const { candidates, manual } = collectCandidates(envelope);
  log(`Found ${candidates.length} rewrite candidate(s) and ${manual.length} manual site(s).`);

  const applied = [];
  const skipped = [];
  const changedFiles = [];

  for (const [relPath, group] of groupByPath(candidates)) {
    // Only existing regular files inside the checkout, never `.git/` or
    // `.github/`, and never through a symlink (`src/guard.js`).
    const refusal = pathRefusal(workspace, relPath);
    if (refusal) {
      group.forEach((c) => skipped.push({ candidate: c, reason: refusal }));
      continue;
    }

    const absPath = path.resolve(workspace, relPath);
    const content = fs.readFileSync(absPath, "utf8");
    const result = applyCandidatesToFile(content, group, { window });

    result.applied.forEach((a) => applied.push(a));
    result.skipped.forEach((s) => skipped.push(s));

    if (result.changed) {
      if (!dryRun) fs.writeFileSync(absPath, result.content);
      changedFiles.push(relPath);
    }
  }

  // Report.
  log("");
  log(`Applied: ${applied.length}`);
  applied.forEach((a) => log(`  ✓ ${describe(a.candidate)}${a.drift ? ` [drift ${a.drift > 0 ? "+" : ""}${a.drift} line(s)]` : ""}`));
  log(`Skipped: ${skipped.length}`);
  skipped.forEach((s) => log(`  ✗ ${describe(s.candidate)} — ${s.reason}`));
  if (manual.length) {
    log(`Manual (Dialecto refused to compute a safe rewrite): ${manual.length}`);
    manual.forEach((m) => log(`  ! ${m.path}:${m.start_line ?? "?"} — ${m.reason}`));
  }

  // Step summary.
  let summary = "### Dialecto source rewrites\n\n";
  summary += `- Applied: **${applied.length}**\n- Skipped: **${skipped.length}**\n- Manual: **${manual.length}**\n`;
  if (changedFiles.length) summary += `\nChanged files:\n` + changedFiles.map((f) => `- ${inlineCode(f)}`).join("\n") + "\n";
  if (skipped.length) {
    summary += `\n<details><summary>Skipped candidates</summary>\n\n`;
    summary += skipped.map((s) => `- ${inlineCode(`${s.candidate.path}:${s.candidate.start_line ?? "?"}`)} — ${s.reason}`).join("\n");
    summary += `\n\n</details>\n`;
  }
  if (manual.length) {
    summary += `\n<details><summary>Update manually</summary>\n\n`;
    summary += manual.map((m) => `- ${inlineCode(`${m.path}:${m.start_line ?? "?"}`)} — ${inlineCode(m.reason)}`).join("\n");
    summary += `\n\n</details>\n`;
  }
  appendSummary(summary);

  setOutput("applied-count", applied.length);
  setOutput("skipped-count", skipped.length);
  setOutput("manual-count", manual.length);
  setOutput("changed-files", changedFiles.join("\n"));
  setOutput("applied", JSON.stringify(applied.map((a) => ({ path: a.candidate.path, start_line: a.candidate.start_line, drift: a.drift }))));
  setOutput("skipped", JSON.stringify(skipped.map((s) => ({ path: s.candidate.path, start_line: s.candidate.start_line, reason: s.reason }))));

  if (doCommit && !dryRun && changedFiles.length) {
    try {
      commitChanges(workspace, changedFiles, commitMessage);
    } catch (err) {
      log(`Commit/push failed: ${err.message}`);
      return 1;
    }
  } else if (doCommit && dryRun) {
    log("Commit requested but dry-run is on — not committing.");
  }

  if (failOnSkip && skipped.length) {
    log("fail-on-skip is set and there were skipped candidates — exiting non-zero.");
    return 1;
  }

  return 0;
}

process.exit(main());
