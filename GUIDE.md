# Quality Gate — Practical Usage Guide

A no-nonsense guide to running the MarketInk Quality Gate on any of your
projects, reading its reports, and automating it with git and CI.

If you only read one thing: **this tool is a read-only scanner. It tells you
what's wrong; it never touches your code, your git history, or your
dependencies.** The worst it can do is write a report file into a folder you
choose.

---

## 1. The mental model (read this first)

Most of the confusion from early testing comes from *how you scoped the scan*.
Here is the model:

| Concept | What it means |
|---|---|
| **Read-only** | It runs `ruff check`, `eslint`, `mypy`, `tsc --noEmit`, `npm audit`, `gitleaks detect`, etc. — all in *check* mode. No `--fix`, no `--write`, ever. |
| **Auto-detect** | It only runs a tool if that tool is already installed. Missing tool → `SKIP`, never an error. This is why a repo with no Python tools shows every Python row as `SKIP`. |
| **Scoped by default** | With no flags, it scans **only the files that changed** vs your base branch (`origin/main`, `main`, …). This is the intended day-to-day mode. |
| **`--all` is the exception** | `--all` scans the *entire* project. On a big/legacy repo this floods you with pre-existing issues **and disables the AI review** (AI is diff-based). Use it for a one-time audit, not daily. |
| **AI review is diff-based** | The Claude review only runs on a diff. `--all` → AI is skipped. That's expected, not a bug. |

> **What you saw in your test:** your report was a `--all` scan of a Next.js repo
> with no Python tools installed. Result: every Python check `SKIP`, ESLint/TS
> showing *all* legacy issues at once, `npm audit` erroring (no lockfile), and AI
> skipped (because `--all`). That's the "flood + no AI" combination. See
> [§9 Diagnosing your test run](#9-diagnosing-your-test-run) — it wasn't broken,
> just scoped for maximum noise.

**The real use case:** run it with *no flags* on a repo you're actively working
in, right before you commit or open a PR. You get a short list of issues **in the
code you just wrote** (not the whole codebase), plus an AI review of your diff.

---

## 2. Prerequisites

- **Node.js 18+** (20+ recommended) — the only hard requirement. The scanner
  itself has zero dependencies (no `npm install`).
- **The check tools are optional.** Install only the ones a given project uses;
  the gate runs what it finds and skips the rest.

```powershell
# Python projects (global, or inside the project's venv):
pip install ruff mypy bandit pip-audit

# JS/TS projects (install as dev deps INSIDE the project so the scanner
# finds them in node_modules/.bin):
npm install -D eslint prettier typescript

# Secret scanning (one binary, works on any project):
winget install gitleaks.gitleaks        # Windows
# brew install gitleaks                  # macOS

# AI review (optional): install Claude Code so `claude` is on PATH.
```

> Rule of thumb: **JS/TS tools must be local to the project** (`node_modules`).
> **Python tools and gitleaks are found on your PATH** (global or venv).

---

## 3. Where the tool lives and where to run it

The scanner lives here (its own repo):

```
E:\MarketInk\Quality_Gate\quality-gate\scan.js
```

You do **not** copy it into every project. You point it at a project with
`--path`. Two facts that trip people up:

1. **`--path` = the project you scan.** Defaults to the current directory.
2. **Reports are written to the directory you run the command *from*** (your
   current working directory), as `./quality-reports/`. They are **not** written
   into the scanned project unless you `cd` there or pass `--out`.

So there are two comfortable ways to work:

**Option A — stand in the project you're scanning (most intuitive):**
```powershell
cd E:\path\to\my-project
node E:\MarketInk\Quality_Gate\quality-gate\scan.js
# report → E:\path\to\my-project\quality-reports\latest.md
```

**Option B — stand in the tool folder, scan from outside (zero-touch):**
```powershell
cd E:\MarketInk\Quality_Gate\quality-gate
node scan.js --path E:\path\to\my-project
# report → E:\MarketInk\Quality_Gate\quality-gate\quality-reports\latest.md
```

Windows shortcut wrapper (same as `node scan.js`, passes all args through):
```powershell
E:\MarketInk\Quality_Gate\quality-gate\quality.ps1 --path E:\path\to\my-project
```
On macOS/Linux the equivalent is `./quality`.

> **Tip:** make it a one-word command. Add a PowerShell function to your
> `$PROFILE`:
> ```powershell
> function qg { node E:\MarketInk\Quality_Gate\quality-gate\scan.js @args }
> ```
> Then from any project: `qg` (scan changes) or `qg --all` (full audit).

---

## 4. Command cheat sheet

Every flag, in plain English, with when to use it.

| Flag | What it does | When to use |
|---|---|---|
| *(none)* | Scan **changed files** vs base branch + AI review of the diff | **Default. Before every commit/PR.** |
| `--path DIR` | The project to scan (default: current dir) | Always, in Option B above |
| `--all` | Scan the **whole project** (disables AI) | One-time audit of a repo |
| `--staged` | Scan only `git add`-ed changes + AI review of staged diff | Inside a pre-commit hook |
| `--base REF` | Diff against a specific ref (tag/branch/commit) | Review "everything since last release": `--base v1.4.0` |
| `--no-ai` | Skip the Claude review (faster, offline, CI-friendly) | CI, or when you just want the linters |
| `--ai-full` | Run **all 6** AI reviewers (review + security + architecture + performance + business-logic + supabase) | Deep review before a big merge |
| `--no-report` | Print to console only; write nothing anywhere | Truly zero-touch spot check |
| `--out DIR` | Where to write the report | Pin reports to a fixed folder |
| `--strict` | **Exit code 1** if there are findings | CI gating / git hooks that should block |
| `--timeout SEC` | Per-tool timeout (default 600s) | Very large repos that time out |

**Exit codes:** `0` = ran fine (even with findings). `1` = only with `--strict`
*and* there were findings. `2` = bad `--path`. This is why it's safe in CI by
default — it can't fail your build unless you opt in with `--strict`.

---

## 5. The recipes you'll actually use

```powershell
# 1. Daily driver — "did I introduce anything bad?" (changed files + AI)
qg

# 2. Quick, no AI — just the linters/type/security checks on your changes
qg --no-ai

# 3. Deep review before opening an important PR (all 6 AI reviewers)
qg --ai-full

# 4. One-time audit of an existing/legacy repo (whole project, no AI noise)
qg --path E:\path\to\legacy-repo --all --no-ai

# 5. Review everything since your last release
qg --base v1.4.0

# 6. Pre-commit style — only what you've staged
qg --staged

# 7. Spot check that writes nothing at all
qg --path E:\path\to\repo --no-report
```

---

## 6. Reading the report

After a run you get three files in `quality-reports/`:

- `latest.md` — human-readable, **read this one**.
- `latest.json` — same data, machine-readable (for dashboards/automation).
- `report-YYYYMMDD-HHMMSS.md` — timestamped history.

Each check has a status:

| Status | Meaning | Action |
|---|---|---|
| **PASS** | Tool ran, found nothing | 🎉 nothing to do |
| **FINDINGS** | Tool ran, found issues | Read the Details section, fix them |
| **SKIP** | Tool not installed, or nothing in scope for it | Install the tool (§2) if you want that check |
| **ERROR** | Tool crashed or timed out | See §8 — often a missing lockfile or a real timeout |
| **OFF** | Disabled in config | You turned it off in `quality-gate.config.json` |

The **Details** section only lists `FINDINGS` and `ERROR` checks, each with the
exact command it ran and the raw tool output — so you can reproduce it yourself.
The **AI Review** section (when present) is Claude's prose analysis of your diff.

---

## 7. Configuration (optional)

`quality-gate.config.json` (next to `scan.js`) has two optional knobs. Delete the
file entirely and safe defaults still apply.

```json
{
  "base_ref": null,
  "disabled_checks": []
}
```

- `base_ref` — default git ref to diff against. `null` = auto-detect
  (`origin/main` → `main` → …). Set it if your default branch is unusual.
- `disabled_checks` — check ids you never want to run. Valid ids:
  `ruff`, `ruff-format`, `mypy`, `bandit`, `pip-audit`, `eslint`, `prettier`,
  `tsc`, `npm-audit`, `gitleaks`, `supabase`.
  Example — silence npm audit and secrets: `["npm-audit", "gitleaks"]`.

---

## 8. Troubleshooting (the ones you'll hit)

- **Everything Python shows `SKIP`** → those tools aren't installed. `pip install
  ruff mypy bandit pip-audit`. Same idea for JS: install eslint/prettier/tsc as
  dev deps *in the project*.
- **`npm audit` → ERROR `ENOLOCK` / "requires an existing lockfile"** → the
  project has no `package-lock.json`. Either run `npm i --package-lock-only` in
  the project once, or disable `npm-audit` in the config. (This is exactly what
  the Next.js test repo hit.)
- **`tsc` complains "Could not find a declaration file for module 'pg'"** →
  that's a real project gap (`npm i -D @types/pg`), not a scanner issue. The gate
  is faithfully reporting your `tsc --noEmit` output.
- **AI review skipped** → either `claude` isn't on PATH, or you used `--all` (AI
  is diff-based — use a scoped scan). Also skips if the diff is empty.
- **"not a git repository — scanning the whole project"** → expected outside a
  repo; it falls back to `--all` automatically.
- **A tool timed out** → raise `--timeout`, e.g. `--timeout 1200`.

---

## 9. Diagnosing your test run

Your report (`report-20260721-170014.md`) scanned `D:\Hackathon` with `--all`.
Here's a line-by-line read so the tool makes sense:

| What the report showed | Why | The fix / takeaway |
|---|---|---|
| All 5 Python checks `SKIP` | No `ruff`/`mypy`/`bandit`/`pip-audit` on PATH | Expected — it's a JS/TS repo. Nothing to do. |
| ESLint `FINDINGS` (101 problems) | `--all` scanned *every* file, surfacing all legacy `any`/unused-var issues | Run without `--all` next time to see only *your* new issues |
| TypeScript `FINDINGS` | Real `tsc --noEmit` errors (missing `@types/pg`, implicit any) | Genuine issues worth fixing in that repo |
| `npm audit` `FINDINGS`/ERROR | No `package-lock.json` (ENOLOCK) | `npm i --package-lock-only` or disable the check |
| Gitleaks `SKIP` | gitleaks not installed | `winget install gitleaks.gitleaks` to enable |
| AI review `SKIP` | `--all` disables the diff-based AI review | Drop `--all`; use a scoped scan for AI |

**Net:** the tool worked perfectly — you just pointed it at "everything" on a repo
missing most tools. Try this instead, from inside a repo you're editing:
```powershell
qg               # or: node E:\...\scan.js --path .
```
You'll get a short, relevant list plus an AI review of your actual changes.

---

## 10. Automating with git (per project)

You have three levels of automation. Pick based on how much you trust the signal.

### Level 1 — Local pre-commit hook (fast, non-blocking)
Warns you at commit time but never blocks. Create
`<project>\.git\hooks\pre-commit` (no extension), make it executable:

```bash
#!/usr/bin/env bash
# Scan staged changes, print advice, never block the commit.
node /e/MarketInk/Quality_Gate/quality-gate/scan.js --staged --no-ai --no-report
exit 0   # always succeed — this is advisory
```

### Level 2 — Local pre-push hook (blocking gate)
Blocks a push if there are findings in your changes. Create
`<project>\.git\hooks\pre-push`:

```bash
#!/usr/bin/env bash
# Block the push if the scanner finds issues in the diff.
node /e/MarketInk/Quality_Gate/quality-gate/scan.js --no-ai --strict
# --strict makes the scanner exit 1 on findings, which aborts the push.
```

> Git hooks live in `.git/hooks/` and aren't committed. To share them with a team,
> put the scripts in a tracked folder (e.g. `.githooks/`) and run
> `git config core.hooksPath .githooks` once per clone. On Windows, hooks run via
> Git Bash, so use the `/e/...` style path shown above.

### Level 3 — CI on every pull request (team standard)
A ready-made GitHub Actions workflow ships with the tool at
`.github/workflows/quality-scan.yml`. It:

- runs on every PR (and manual dispatch),
- scans the **PR diff** (`--base origin/<base_branch>`),
- is **`continue-on-error: true`** — never fails the build,
- uploads the report as a downloadable artifact.

Copy it into a project:
```powershell
Copy-Item E:\MarketInk\Quality_Gate\quality-gate\.github\workflows\quality-scan.yml `
          E:\path\to\my-project\.github\workflows\
```

Then in that project's `.gitignore`, add so reports don't get committed:
```
quality-reports/
.quality-gate-tool/
```

The workflow clones the scanner from your repo
(`https://github.com/sarthakkk1212/quality-gate.git`) at run time. If you install
the check tools in the workflow (uncomment the `pip install …` step), add
whichever the repo uses. **Make it blocking later** by flipping
`continue-on-error: true` → `false` — only once the team trusts the signal.

---

## 11. Recommended rollout for a new project

1. **Install the check tools** the project uses (§2).
2. **Add a `qg` shortcut** to your PowerShell profile (§3) so it's one word.
3. **Use it daily:** run `qg` before committing. Fix what's in *your* diff.
4. **One-time audit:** run `qg --path . --all --no-ai` once to see the whole
   backlog, then ignore it day-to-day (clean-as-you-code).
5. **Optional AI standards:** copy
   `.quality\standards\CLAUDE.template.md` into the project as `CLAUDE.md` and
   fill in the domain so the AI review understands your business rules.
6. **Automate** when ready: pre-push hook (Level 2) for yourself, CI workflow
   (Level 3) for the team.

---

## Quick reference card

```
qg                          # daily: scan my changes + AI review
qg --no-ai                  # daily, faster: just the linters
qg --ai-full                # deep AI review before a big PR
qg --staged                 # only staged changes (pre-commit)
qg --base v1.4.0            # everything since a release
qg --path ..\repo --all --no-ai   # one-time full audit of another repo
qg --strict                 # exit 1 on findings (hooks/CI gating)
qg --no-report              # console only, write nothing

# qg = node E:\MarketInk\Quality_Gate\quality-gate\scan.js
# Report → ./quality-reports/latest.md (in the folder you ran it from)
# It never edits code, never touches git, never installs anything.
```
