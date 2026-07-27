# Quality Gate — How to Run & Auto-Run (cheat sheet)

A read-only scanner. It **never edits code, never changes git state, never
installs anything.** The only thing it writes is a report (unless you pass
`--no-report`). Scanner lives at `quality-gate/scan.js` (Node 18+, zero npm deps).

---

## 1. Test results (validated 2026-07-24)

Ran the scanner against `sample-review-code/` (19 deliberately planted issues in
`REVIEW-ANSWER-KEY.md`).

- **Detection: 19 / 19 planted issues found, 0 false positives.** All SEC-01→15,
  BUG-01/02/03, QUAL-01. The single default AI reviewer caught everything;
  `--ai-full` (6 specialized reviewers) reconfirmed it.
- **Every command/flag works:** `--help`, default, `--all`, `--staged`, `--base`,
  `--path`, `--no-ai`, `--ai-full`, `--no-report`, `--out`, `--strict` (exits 1),
  `--timeout`; bad flags error cleanly (exit 2).
- **Safety held:** nothing written into the scanned project, git untouched.

Two things to know:
- **`npm audit` shows FINDINGS when it actually failed** if there's no
  `package-lock.json` (`ENOLOCK`). Run `npm install` first, or disable `npm-audit`
  in `quality-gate.config.json`.
- **The built-in Supabase check is regex-based** and only catches obvious key
  leaks. Deep Supabase issues (service_role as default client, `.or()` injection,
  IDOR) are caught by the **AI review** — which only runs on a scoped (non-`--all`)
  scan with `claude` on PATH.

---

## 2. Run it manually — pick by need

Run from inside a repo, or point at one with `--path`. On Windows you can use
`.\quality.ps1 …` instead of `node scan.js …`.

| I want to… | Command |
|---|---|
| Check my current changes (+ AI review) | `node scan.js` |
| Fast check, no AI | `node scan.js --no-ai` |
| Deep AI review (6 specialized reviewers) | `node scan.js --ai-full` |
| Check only what's staged | `node scan.js --staged` |
| Review since a release/tag | `node scan.js --base v1.4.0` |
| Scan a **different** repo, zero-touch | `node scan.js --path ../other-repo` |
| Whole-project audit (no AI) | `node scan.js --path ../repo --all --no-ai` |
| Print only, write nothing | `node scan.js --no-report` |
| Send report elsewhere | `node scan.js --out ./reports` |
| CI gate (exit 1 on findings) | `node scan.js --staged --no-ai --strict` |
| Slow/huge repo | `node scan.js --timeout 1200` |
| See all options | `node scan.js --help` |

> AI review needs `claude` on PATH and a **diff** — it's skipped on `--all`.
> Deterministic checks need their tools installed (see §5); missing ones just SKIP.

---

## 3. Auto-run on commit & push (the hooks)

**Yes, this is possible.** Each project is onboarded **once**, then the gate runs
automatically on every `git commit` (fast, staged, deterministic) and `git push`
(fuller review vs the base branch), printing findings so the developer is notified.

### Onboard a project (once, by one person)

Windows:
```powershell
cd quality-gate
.\hooks\install-hooks.ps1 -Repo C:\path\to\your-project
```
macOS/Linux:
```bash
cd quality-gate
./hooks/install-hooks.sh /path/to/your-project
```

The installer, entirely inside the target repo:
1. Vendors the scanner into `<repo>/.quality-gate/` (so it travels with the repo).
2. Installs `pre-commit` + `pre-push` into `<repo>/.githooks/`.
3. Runs `git config core.hooksPath .githooks`.
4. Adds `quality-reports/` to `.gitignore`.

Then commit the setup so it ships with the repo:
```bash
git add .githooks .quality-gate .gitignore
git commit -m "Add MarketInk Quality Gate hooks"
```

### Behaviour & toggles (set as env vars)

| Hook | Default | Scope |
|---|---|---|
| `pre-commit` | notify only, never blocks | staged changes, no AI (fast) |
| `pre-push` | notify only, never blocks | changed vs base, no AI |

- `QG_BLOCK=1` → **abort** the commit/push if there are findings.
- `QG_AI=1` → include the Claude AI review on push (slower).
- `git commit/push --no-verify` → bypass the hook (git built-in escape hatch).

Make blocking the team default by editing the hook, or per-developer:
```bash
git config --global hook.qg-block 1   # (illustrative; the hooks read QG_BLOCK env)
export QG_BLOCK=1                      # or set it in your shell profile
```

---

## 4. The honest catch about "everyone gets it on pull"

Git **deliberately** does not run hooks that arrive via `clone`/`pull` — auto-
executing code from a fetched repo would be a security hole. So there is always
**one** action per developer per clone:

```bash
git config core.hooksPath .githooks
```

That's the "onboarding once per machine" step — it can't be avoided for *local*
hooks. Two ways to make enforcement truly automatic and unbypassable:

- **CI (recommended backstop):** copy `.github/workflows/quality-scan.yml` into the
  repo. It runs the gate **server-side on every PR/push** for everyone, with zero
  local setup, and posts the report as a PR comment. Nobody can `--no-verify` it.
  Flip `continue-on-error: false` to make it block merges.
- **npm `prepare` script (JS repos):** add `"prepare": "git config core.hooksPath .githooks"`
  to `package.json` so `npm install` wires up hooks automatically after clone.

**Best practice: use both layers** — local hooks for instant feedback, CI as the
enforcement that can't be skipped.

---

## 5. Installing the underlying check tools (optional)

The scanner runs only what's present; missing tools SKIP (never fail).

```bash
# JS/TS (as project dev-deps so they're found in node_modules/.bin)
npm install -D eslint prettier typescript
# Python
pip install ruff mypy bandit pip-audit
# Secrets (one binary)
winget install gitleaks.gitleaks      # Windows
brew install gitleaks                 # macOS
# AI review: install Claude Code so `claude` is on PATH
```

---

## 6. Files added by this setup

| File | Purpose |
|---|---|
| `hooks/pre-commit` | fast staged scan on commit |
| `hooks/pre-push` | fuller scan on push |
| `hooks/install-hooks.ps1` / `.sh` | one-time per-project onboarding |
| `<repo>/.quality-gate/` | vendored scanner (committed with the repo) |
| `<repo>/.githooks/` | the installed hooks (committed with the repo) |
