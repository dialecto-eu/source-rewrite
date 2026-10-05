# source-rewrite (Dialecto source rewrite)

A GitHub Action that applies Dialecto's computed call-site rewrites (gettext and JSON keys) inside the
user's own CI: when a msgid or key is renamed in Dialecto, the pull request body carries a JSON block
and this action edits the calls in the checkout. Public, MIT, in the `dialecto-eu` org. The rewrites
are computed in the Dialecto app (`dlocal` repo; spec 4 and spec 18 in `ddd-plan`); `dialecto-astro`
runs this action in its generated rename workflow. Main line: `main`; consumers use
`dialecto-eu/source-rewrite@v1`.

## Layout

`index.js` (entry), `src/parse.js` (reads the block between the
`<!-- dialecto:source-rewrites:begin ... -->` and `:end -->` markers), `src/apply.js` (re-anchors and
edits), `src/guard.js` (safety rules), `action.yml` (inputs and outputs), `test/`.

## Run and verify

```sh
npm test        # node --test, Node 20+
```

## Rules that bite

- No runtime dependencies (Node built-ins only) and no network access. The action holds no Dialecto
  credentials.
- The PR body is untrusted input. Only existing regular files inside the checkout; refuse absolute
  paths, `..`, symlinks, `.git/` and `.github/`; refuse fork PRs, heads outside `branch-prefix`
  (default `dialecto/`) and, when set, authors outside `allowed-authors`; refuse a body with more than
  one begin marker; commit with `--no-verify`.
- Re-anchoring: exact match on `start_line`, else exactly one match within `anchor-window`; otherwise
  skip and report, never guess. Resolve all candidates against the original content before writing;
  refuse overlaps.
- The block format `dialecto.source-rewrites/v1` is shared with the app; a change there breaks
  published consumers.
