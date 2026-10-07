<p align="center">
  <a href="https://dialecto.eu">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/brand/readme-banner-dark.svg">
      <img alt="Dialecto" src=".github/brand/readme-banner-light.svg" width="420">
    </picture>
  </a>
</p>

# Dialecto source rewrite

A GitHub Action that applies Dialecto's computed call-site rewrites to your source files, inside your own CI. Your
source code is read by this action on your runner and goes nowhere else: the action makes no network requests and
holds no Dialecto credentials.

Documentation lives at [dialecto.eu/docs](https://dialecto.eu/docs).

## What it does

In gettext the `msgid` is the source string, written right in the call: `gettext("Get started")`. When someone
renames that msgid in Dialecto, the `.po` and `.pot` files change, and the calls in your code must change with them.
If they don't, the app looks up the old string, finds no translation, and quietly shows the old label.

Dialecto works out each of those edits and puts them in the body of the pull request it opens, as a block of JSON
between two fixed comment markers. This action runs on that pull request, finds each call in your checkout, and
applies the edit. Any call it cannot locate uniquely and safely is skipped and reported, never guessed at. The same
mechanism applies to JSON translation keys.

The steps, in order:

1. Read the pull request body from the workflow's event payload.
2. Find the rewrites block between `<!-- dialecto:source-rewrites:begin … -->` and
   `<!-- dialecto:source-rewrites:end -->`.
3. For each candidate, locate the exact captured call bytes at `path` and `start_line`, searching a small window of
   lines around it when the file has drifted since Dialecto's scan.
4. Replace those bytes, or skip the candidate when there is no single safe location.
5. Write a step summary of what was applied, skipped, and left for a human.

## What Dialecto reads, and what it never reads

Dialecto reads only your translation files, never your source code. The Dialecto GitHub App reads only the
translation-file paths confirmed for your project. Each time it reads, it also matches the names in the repository's
file listing, never their contents, against the pattern list below, and shows the project's managers any translation
files it finds outside those paths; nothing under them is read until someone adds the path.

The patterns it looks for are these:

- `**/LC_MESSAGES/*.po`: gettext catalogs, one folder per language.
- `**/*.pot`: gettext templates and the catalogs beside them.
- `**/config/locales/**/*.yml`: Rails locale files.
- `**/_locales/*/messages.json`: browser-extension messages.
- `**/<source locale>.json`: one JSON file per language, beside the source-language file.
- `**/<source locale>/*.json`: one folder per language, each holding namespace files.

Folders named `node_modules`, `vendor`, `deps`, `_build`, `build`, `dist`, `tmp`, `log`, `coverage`, `test`,
`spec` or `fixtures`, and any folder whose name starts with a dot, are never proposed. A person can still confirm a
path under one of them by hand.

That is an improvement over reading the whole source tree, which GitHub's permission would allow. There is one
caveat, and it is part of the design: GitHub's Contents permission applies to the whole repository, so GitHub does
not enforce the boundary. Dialecto's own code does. A team that wants the boundary enforced outside Dialecto's code
can block the App's read access and let its CI push the translation files instead (CI-push mode); the generated
workflow lists exactly which paths it sends, in your own repository.

### Where source code is involved

Renaming a gettext msgid needs to know where the string is called. Those call sites come from source code, so the
App's read never provides them. They reach Dialecto only if you run Dialecto's separate CI usage-scan step, which
sends short snippets (the file, the line range and the bytes of each gettext call) with the scan. That step is
optional, runs in your CI, and is described at
[dialecto.eu/docs/scan-action-cli](https://dialecto.eu/docs/scan-action-cli). Without it, renames still work in the
catalogs, and this action simply has nothing to apply. This action is the other half: it takes the rewrites Dialecto
computed from those snippets and applies them to the real files, so Dialecto never needs to hold or fetch a whole
source file.

## What runs where

| Where | What happens |
| --- | --- |
| Your CI runner | This action: reads the pull request event, reads and edits files in your checkout, optionally runs `git commit` and `git push`. |
| Dialecto's servers | Nothing. The action opens no network connection, has no endpoint to call, and needs no Dialecto token. |
| GitHub | The only credential used is the `GITHUB_TOKEN` that `actions/checkout` persisted, and only when you set `commit: true`. |

The action has no runtime dependencies. It uses only Node built-in modules and is plain JavaScript, so there is
nothing to download, build or vendor.

## Install and usage

Add a workflow to the repository that Dialecto opens pull requests against:

```yaml
name: Apply Dialecto source rewrites
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write      # only needed when commit: true
  pull-requests: read

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # Check out the PR head branch so edits land on it, with a token that can push back.
          ref: ${{ github.head_ref }}
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: dialecto-eu/source-rewrite@v1
        with:
          commit: true
```

To control the commit yourself, leave `commit` off (the default). The action then only edits the working tree:

```yaml
      - uses: dialecto-eu/source-rewrite@v1

      - name: Commit applied rewrites
        run: |
          git config user.name  "dialecto-bot"
          git config user.email "dialecto-bot@users.noreply.github.com"
          git add -A
          git diff --staged --quiet || git commit -m "Apply Dialecto source rewrites"
          git push
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `pr-body` | the event payload | Overrides the pull request body to parse. Skips the pull request checks below, because the workflow vouches for it. |
| `branch-prefix` | `dialecto/` | Apply only when the pull request's head branch starts with this. Dialecto's branches do. Empty disables the check. |
| `allowed-authors` | empty | Comma- or space-separated logins allowed to author the pull request, for example your Dialecto app's bot. Empty allows any author. |
| `working-directory` | `$GITHUB_WORKSPACE` | The repository root that candidate paths resolve against. |
| `anchor-window` | `25` | How many lines around `start_line` to search when the captured call has drifted. |
| `dry-run` | `false` | Parse, re-anchor and report without writing any file. |
| `commit` | `false` | Commit and push applied rewrites to the pull request's head branch, using the credentials `actions/checkout` persisted. The job needs `contents: write`. Repository git hooks are skipped. |
| `commit-message` | `Apply Dialecto source call-site rewrites` | The commit message when `commit` is true. |
| `fail-on-skip` | `false` | Exit non-zero if any candidate was skipped. |

### Outputs

| Output | Description |
| --- | --- |
| `applied-count` | Number of rewrites applied. |
| `skipped-count` | Number of candidates skipped. |
| `manual-count` | Number of sites Dialecto marked unrewritable, which need a human. |
| `changed-files` | Newline-separated list of modified files. |
| `applied` | JSON array of applied edits (`{ path, start_line, drift }`). |
| `skipped` | JSON array of skipped candidates (`{ path, start_line, reason }`). |

Skip reasons: `not_found`, `out_of_window`, `ambiguous`, `conflict`, `no_replacement`, `empty_match`, `file_missing`,
`bad_path`, `path_escape`, `protected_path`, `symlink`, `not_a_file`.

## The block it reads

````
<!-- dialecto:source-rewrites:begin schema="dialecto.source-rewrites/v1" -->
<details>
<summary>Machine-readable rewrites — the Dialecto CI action applies these</summary>

```json
{
  "schema": "dialecto.source-rewrites/v1",
  "renames": [
    {
      "old_msgid": "Get started",
      "new_msgid": "Begin",
      "candidates": [
        {
          "path": "lib/app_web/home_live.ex",
          "start_line": 38,
          "end_line": 38,
          "match": "        <%= gettext(\"Get started\") %>\n",
          "replacement": "        <%= gettext(\"Begin\") %>\n"
        }
      ],
      "unrewritable": [
        {
          "path": "lib/app_web/other.ex",
          "start_line": 7,
          "end_line": 7,
          "content": "<%= gettext(label_var) %>\n",
          "reason": "msgid_not_literal"
        }
      ]
    }
  ]
}
```

</details>
<!-- dialecto:source-rewrites:end -->
````

- `candidates` are sites with a computed safe rewrite. The action replaces `match` with `replacement`.
- `unrewritable` are sites Dialecto declined to touch, for example a variable msgid. The action lists them as
  "update manually" and never edits them.

## What the action will and won't touch

The rewrites come from a pull request body and the job can push, so the action treats the body as untrusted input
(see `src/guard.js`):

- **Only source files.** A rewrite may edit an existing regular file inside the checkout. Absolute paths, `..`,
  symlinks (including a symlinked parent that leads out), anything under `.git/` and anything under `.github/` are
  refused.
- **Only Dialecto's pull requests.** When a rewrites block is present, the action exits with an error and changes
  nothing if the pull request comes from a fork, if its head branch doesn't start with `branch-prefix`, or, when
  `allowed-authors` is set, if its author isn't listed.
- **No branch code runs.** The commit uses `--no-verify`, so hooks that the branch installs (husky and the like)
  don't run with the job's token.
- **Exactly one block.** Dialecto writes one block and breaks the marker wherever it appears in text it didn't
  write. A body with a second begin marker is refused rather than guessed at.

## How re-anchoring stays safe

The captured `match` is the exact call bytes, including indentation and the trailing newline. The action locates
that byte sequence instead of trusting `start_line` blindly:

- **Exact anchor.** A single occurrence on `start_line` is applied, even if the same bytes appear elsewhere.
- **Drift.** No occurrence on `start_line`, but exactly one within `anchor-window` lines, is applied.
- **Ambiguous, out of window or missing.** Skipped and reported, never guessed.

All candidates for a file are resolved against the original content before any write, and overlapping edits are
refused, so one edit can never shift or corrupt another.

## Run your own fork

Everything the action does is in this repository, so you can run your own version.

1. Fork the repository, or copy it into your organization.
2. Pin your fork to a full commit SHA, which cannot be moved after the fact:

   ```yaml
   - uses: your-org/your-fork@0123456789abcdef0123456789abcdef01234567
   ```

3. Review and change whatever you like. `index.js` is the entry point, `src/parse.js` reads the block,
   `src/apply.js` re-anchors and edits, and `src/guard.js` holds the safety rules.

There are no hidden dependencies on Dialecto's servers. The action has no runtime npm dependencies, makes no network
requests, and needs no Dialecto account or token. The only link to Dialecto is the shape of the block in the pull
request body (`dialecto.source-rewrites/v1`), which is a plain JSON format described above. If you change what the
action accepts, you keep working with any pull request that carries that block, and you can write the block
yourself if you want to produce rewrites by other means.

## Develop

Node 20 or later. Tests use `node:test` and `node:assert`:

```sh
npm test
```

The safety guarantees above are what the tests protect, so please keep the action free of runtime dependencies and
network access.

## Licence

MIT. See [LICENSE](LICENSE).

## Security

Please report vulnerabilities privately, through GitHub's private vulnerability reporting on this repository, and not
in a public issue.

## Contributing

Issues and pull requests are welcome. Please keep changes small and tested, keep the action free of runtime
dependencies and network access, and do not change the guards in `src/guard.js` without a major version.
