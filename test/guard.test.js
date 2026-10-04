import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pathRefusal, pullRequestRefusal, inlineCode } from "../src/guard.js";

// A checkout with a source file, git metadata, a workflow, a symlink to a file
// outside it, and a symlinked directory leading outside it.
function checkout() {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rewrite-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rewrite-checkout-"));
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib", "app.ex"), 'gettext("Hi")\n');
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n");
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "on: push\n");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "lib", "link.ex"));
  fs.symlinkSync(outside, path.join(root, "vendor"));
  return root;
}

test("a source file inside the checkout may be edited", () => {
  const root = checkout();
  assert.equal(pathRefusal(root, "lib/app.ex"), null);
  assert.equal(pathRefusal(root, "./lib/app.ex"), null);
});

test("paths that leave the checkout are refused", () => {
  const root = checkout();
  assert.equal(pathRefusal(root, "../etc/passwd"), "path_escape");
  assert.equal(pathRefusal(root, "lib/../../etc/passwd"), "path_escape");
  assert.equal(pathRefusal(root, "/etc/passwd"), "path_escape");
  assert.equal(pathRefusal(root, "C:/Windows/win.ini"), "path_escape");
});

test("git metadata and CI configuration are never edited", () => {
  const root = checkout();
  assert.equal(pathRefusal(root, ".git/config"), "protected_path");
  assert.equal(pathRefusal(root, ".GIT/config"), "protected_path");
  assert.equal(pathRefusal(root, "sub/.git/config"), "protected_path");
  assert.equal(pathRefusal(root, ".github/workflows/ci.yml"), "protected_path");
  assert.equal(pathRefusal(root, "./.github/workflows/ci.yml"), "protected_path");
});

test("symlinks are refused, including a symlinked directory leading out", () => {
  const root = checkout();
  assert.equal(pathRefusal(root, "lib/link.ex"), "symlink");
  assert.equal(pathRefusal(root, "vendor/secret.txt"), "path_escape");
});

test("missing, empty and odd paths are refused", () => {
  const root = checkout();
  assert.equal(pathRefusal(root, "lib/gone.ex"), "file_missing");
  assert.equal(pathRefusal(root, "lib"), "not_a_file");
  assert.equal(pathRefusal(root, ""), "bad_path");
  assert.equal(pathRefusal(root, "."), "bad_path");
  assert.equal(pathRefusal(root, "lib/app.ex\0.txt"), "bad_path");
  assert.equal(pathRefusal(root, 42), "bad_path");
});

function pr(overrides = {}) {
  return {
    user: { login: "dialecto[bot]" },
    head: { ref: "dlocal/translations", repo: { full_name: "acme/site" } },
    base: { repo: { full_name: "acme/site" } },
    ...overrides,
  };
}

test("Dialecto's own pull request is allowed", () => {
  assert.equal(pullRequestRefusal(pr(), { branchPrefix: "dlocal/" }), null);
  assert.equal(
    pullRequestRefusal(pr(), { branchPrefix: "dlocal/", allowedAuthors: ["dialecto[bot]"] }),
    null
  );
});

test("a fork's pull request is refused", () => {
  const fork = pr({ head: { ref: "dlocal/translations", repo: { full_name: "mallory/site" } } });
  assert.equal(pullRequestRefusal(fork, { branchPrefix: "dlocal/" }), "fork");
  assert.equal(pullRequestRefusal(pr({ head: { ref: "dlocal/x" } }), {}), "fork");
});

test("another branch or an unlisted author is refused", () => {
  const other = pr({ head: { ref: "feature/x", repo: { full_name: "acme/site" } } });
  assert.equal(pullRequestRefusal(other, { branchPrefix: "dlocal/" }), "branch");
  assert.equal(pullRequestRefusal(other, { branchPrefix: "" }), null);
  assert.equal(
    pullRequestRefusal(pr({ user: { login: "mallory" } }), { allowedAuthors: ["dialecto[bot]"] }),
    "author"
  );
});

test("no pull request at all is refused", () => {
  assert.equal(pullRequestRefusal(null, {}), "no_pull_request");
});

test("paths from the body can't break out of an inline code span", () => {
  assert.equal(inlineCode("lib/a`b.ex"), "`lib/a'b.ex`");
  assert.equal(inlineCode("x\n## heading"), "`x'## heading`");
});
