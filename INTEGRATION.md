# Integrating the Quality Gate into any project

Two ways to use it. Start with **Mode A** — it touches nothing and works on any
repo immediately, including production ones.

---

## Step 0 — Put the scanner in its own git repo (one time)

```bash
cd quality-gate
git init
git add .
git commit -m "MarketInk Quality Gate: read-only scanner"
git branch -M main
git remote add origin https://github.com/MarketInk/quality-gate.git   # your URL
git push -u origin main
```

Now anyone can `git clone` it and scan any project. (If you change the repo URL,
update it in `.github/workflows/quality-scan.yml`.)

---

## Mode A — Zero-touch scan (recommended for existing / running projects)

The scanner lives **outside** the project. Nothing is added to the project.

```bash
git clone https://github.com/MarketInk/quality-gate.git
cd quality-gate

# Scan another repo — reports land here in ./quality-reports, never in the target:
node scan.js --path ../my-existing-service

# Whole-project health check:
node scan.js --path ../my-existing-service --all

# Absolutely zero writes anywhere (console only):
node scan.js --path ../my-existing-service --no-report
```

Read `quality-reports/latest.md`. That's it — the scanned project is untouched.

> First run on a big legacy repo? Use the default (changed-files) scope, or
> `--base <release-tag>` to review everything since your last release, so you're
> not buried in pre-existing issues.

---

## Mode B — Adopt into a repo (for team standardization)

When a team wants everyone to run the same checks locally and in CI, copy a few
files **into** the project. These are inert config/docs — they don't run
anything on their own and don't change how the app builds.

1. **Standards for AI review** — copy and fill in:
   ```
   cp quality-gate/.quality/standards/CLAUDE.template.md  <project>/CLAUDE.md
   ```
   Edit it for the project's domain (see the template's comments).

2. **CI (non-blocking)** — copy the workflow:
   ```
   cp quality-gate/.github/workflows/quality-scan.yml  <project>/.github/workflows/
   ```
   It runs on every PR, is `continue-on-error: true` (never fails the build), and
   uploads the report as an artifact. Make it blocking later by flipping that one
   line — only after the team trusts the signal.

3. **Ignore reports** — add to the project's `.gitignore`:
   ```
   quality-reports/
   .quality-gate-tool/
   ```

4. **Run it locally** the same way as Mode A (`node /path/to/scan.js --path .`),
   or vendor `scan.js` under `tools/` if you prefer it in-repo.

Nothing here blocks commits or pushes. This gate is a **scanner**, not an
enforcer — by design.

---

## Installing the underlying tools

The scanner runs only the tools it finds. Install the ones a project uses; skip
the rest. All commands below install *check* tools — none of them run on their
own.

**Python** (global or in the project's virtualenv):
```bash
pip install ruff mypy bandit pip-audit
```

**JavaScript / TypeScript** (as dev dependencies in the project, so the scanner
finds them in `node_modules/.bin`):
```bash
npm install -D eslint prettier typescript
```

**Secret scanning** (one binary, any project):
- macOS: `brew install gitleaks`
- Windows: `winget install gitleaks.gitleaks` (or `scoop install gitleaks`)
- Linux: download from https://github.com/gitleaks/gitleaks/releases

**AI review** (optional): install Claude Code so `claude` is on your PATH. If
it's absent, the AI step is simply skipped.

> You don't need all of these. Even with none installed, the scanner runs, skips
> everything gracefully, and tells you what to install.

---

## Recommended workflow

| Situation | Command |
|---|---|
| Before opening a PR | `node scan.js` (changed files + AI review) |
| Quick check, no AI | `node scan.js --no-ai` |
| Deep AI review | `node scan.js --ai-full` |
| Auditing an existing repo | `node scan.js --path ../repo --all --no-ai` |
| In CI on a PR | the provided workflow (scoped to the PR diff, non-blocking) |

---

## Troubleshooting

- **"tool not available"** — that tool isn't installed / not in the project's
  `node_modules`. Install it (above) or ignore the line. Not an error.
- **"not a git repository — scanning the whole project"** — expected outside a
  repo; the scanner falls back to `--all`.
- **AI review skipped** — `claude` isn't on PATH, or you used `--all` (AI review
  is diff-based; use a scoped scan).
- **A tool errored / timed out** — shown as `ERROR`, never fatal. Raise
  `--timeout` for very large repos, or disable that check in
  `quality-gate.config.json`.
- **npm audit shows an error** — usually a missing `package-lock.json`. Run
  `npm install` in the project first, or disable `npm-audit` in the config.

---

## Extending it

- Add or edit AI reviewers in `.quality/prompts/`.
- Add a deterministic check by appending one spec to `buildSpecs()` in
  `scan.js`. **Only ever use read-only/check flags** — that invariant is what
  makes this safe to run anywhere.
