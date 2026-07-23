# MarketInk Quality Gate — The Complete Handbook

> **One document, everything you need.** How to install it, use it every day,
> plug it into any project (TS / JS / Python / React / Next.js), automate it with
> GitHub, prove it's actually working, and grow it into a team-wide system where
> everyone can see every run, every PR, and the full history.
>
> Written in plain language. If you read nothing else, read
> [§1 What this is in 60 seconds](#1-what-this-is-in-60-seconds) and
> [§4 Your first 15 minutes](#4-your-first-15-minutes-onboarding).

---

## Table of contents

1. [What this is in 60 seconds](#1-what-this-is-in-60-seconds)
2. [Why we built it (the problem it solves)](#2-why-we-built-it-the-problem-it-solves)
3. [How it works (the mental model)](#3-how-it-works-the-mental-model)
4. [Your first 15 minutes (onboarding)](#4-your-first-15-minutes-onboarding)
5. [Installing the check tools (per stack)](#5-installing-the-check-tools-per-stack)
6. [Daily usage on your machine (local)](#6-daily-usage-on-your-machine-local)
7. [Reading the report](#7-reading-the-report)
8. [Local vs Git vs CI — who does what](#8-local-vs-git-vs-ci--who-does-what)
9. [Configuring it per project (TS / JS / Python / React / Next)](#9-configuring-it-per-project-ts--js--python--react--next)
10. [Automating with GitHub (step by step)](#10-automating-with-github-step-by-step)
11. [The goal: catch issues before the PR merges](#11-the-goal-catch-issues-before-the-pr-merges)
12. [How to validate it's actually working](#12-how-to-validate-its-actually-working)
13. [Extending it: team visibility, PR comments, history, dashboards](#13-extending-it-team-visibility-pr-comments-history-dashboards)
14. [Troubleshooting](#14-troubleshooting)
15. [One-page cheat sheet](#15-one-page-cheat-sheet)
16. [What's built today vs. on the roadmap](#16-whats-built-today-vs-on-the-roadmap)

---

## 1. What this is in 60 seconds

The Quality Gate is a **single Node script** (`scan.js`, zero npm dependencies) that:

- Runs the code-quality tools you already know — linters, type checkers, security
  scanners, dependency auditors — all in **check-only** mode.
- Adds an **AI review by Claude** that reads *only the code you changed* and flags
  the things linters can't: security holes, broken business logic, bad
  architecture, performance traps.
- Produces **one clean report** (console + Markdown + JSON).

**The single most important fact:** it is **100% read-only**. It never edits your
code, never touches git (no commit/push/checkout), never installs anything, and
can't break a build. The only thing it ever writes is a report file into a folder
you choose. That's why it's safe to run on *any* repo, including production, at any
time.

```bash
node scan.js            # scan what you changed + AI review → report
```

---

## 2. Why we built it (the problem it solves)

We were paying for and juggling several external tools to keep code secure and
clean. The problem: **external tools don't understand our context.** They flag
noise, miss the bugs that matter, and don't know our business rules or
architecture. Reviewing that output was itself a chore.

**Our goal is simple:** automate code review and security checks so that **every
time a new feature or code change happens, we catch and fix the problems *before*
the PR is merged** — not after they reach production.

The Quality Gate does that by splitting the work in a way that plays to each
tool's strength:

- **Deterministic tools** (linters/type checkers) handle everything mechanical —
  they're always right and cost nothing to run.
- **Claude** handles the judgment calls — reading *your* diff against *our*
  standards (from your project's `CLAUDE.md`) and explaining real issues in plain
  language.

The result is context-aware review, on demand, for free-ish (you only spend AI
tokens on the diff), that we fully control.

---

## 3. How it works (the mental model)

Four ideas explain 90% of the tool. Internalize these and nothing will surprise
you.

| Idea | What it means |
|---|---|
| **Read-only** | Runs `ruff check`, `eslint`, `mypy`, `tsc --noEmit`, `npm audit`, `gitleaks detect`, etc. — all in *check* mode. There is **no** `--fix` / `--write` anywhere. |
| **Auto-detect** | It only runs a tool that's already installed. A missing tool becomes `SKIP`, never an error. A repo with no Python tools simply shows every Python row as `SKIP`. |
| **Scoped by default** | With no flags, it scans **only the files that changed** vs your base branch (`origin/main`, `main`, …). This is the intended everyday mode — you see issues in *new* code, not a wall of legacy noise ("clean as you code"). |
| **AI is diff-based** | The Claude review only runs on a diff. It reviews *your change*, never the whole repo (that would be noisy and expensive). `--all` disables AI on purpose. |

### The layered idea behind it

Think of quality checks as a series of **filters**. Cheap/fast filters run often
and early; expensive/slow filters run rarely and catch what leaked through.

```
   FAST & CHEAP  ────────────────────────────────►  SLOW & THOROUGH
   runs on your machine, before you push            runs in CI, on every PR

   [ Linters/Types ]  →  [ Secret scan ]  →  [ AI review of diff ]  →  [ CI re-runs all ]
     seconds                seconds              1–3 min                minutes, on GitHub
```

**Golden rule:** catch each class of defect at the *cheapest stage that reliably
can*, and never let the same mistake through twice.

### Deterministic vs. AI — the division of labor

| Deterministic tools own | Claude (AI) owns |
|---|---|
| Formatting, linting, unused variables | Security holes (injection, auth gaps, secrets) |
| Type checking | Business-logic correctness & edge cases |
| Secret scanning | Architecture / layering violations |
| Dependency CVEs | Duplicate logic, bad abstractions, naming |
| | Performance traps (N+1 queries, O(n²) hot paths) |

> Rule of thumb: if a rule can be written as "always/never," it belongs in a
> linter — not an AI prompt. AI is for the judgment a linter can't encode.

---

## 4. Your first 15 minutes (onboarding)

Follow this exactly the first time. It works on Windows, macOS, and Linux.

### Step 1 — Confirm Node (the only hard requirement)

```bash
node --version        # need 18+  (20+ recommended)
```

That's the *only* thing the scanner itself needs. Everything else is optional.

### Step 2 — Get the scanner

The scanner lives in its own folder. On this machine it's already here:

```
E:\MarketInk\Quality_Gate\quality-gate\scan.js
```

On a new machine, clone it once:

```bash
git clone https://github.com/sarthakkk1212/quality-gate.git
```

### Step 3 — Make it a one-word command (highly recommended)

You'll run this constantly, so give it a short alias.

**Windows (PowerShell)** — add to your `$PROFILE`:
```powershell
function qg { node E:\MarketInk\Quality_Gate\quality-gate\scan.js @args }
```

**macOS / Linux** — add to `~/.bashrc` or `~/.zshrc`:
```bash
qg() { node /path/to/quality-gate/scan.js "$@"; }
```

Reload your shell. Now from *any* project folder you just type `qg`.

### Step 4 — Run it on a real project

```bash
cd E:\path\to\some-project     # go into a repo you're working in
qg                             # scan your changes + AI review
```

Read the summary it prints, then open `quality-reports/latest.md`. **You're done.**
It changed nothing in your project.

> **Tip for your very first run on a big/legacy repo:** don't panic if you use
> `--all` and see hundreds of issues — that's every pre-existing problem at once.
> The everyday mode (no flags) only shows issues in *your* changes.

---

## 5. Installing the check tools (per stack)

The scanner runs whatever it finds and skips the rest. Install only what a project
actually uses. **Nothing here runs on its own — these are just the checkers the
gate calls.**

### The golden rule of where tools live

| Tool type | Where it must be installed | Why |
|---|---|---|
| **Python tools** (`ruff`, `mypy`, `bandit`, `pip-audit`) | Global or the project's virtualenv (on your `PATH`) | The scanner looks for them on PATH |
| **JS/TS tools** (`eslint`, `prettier`, `typescript`) | **Inside the project** as dev deps (`node_modules/.bin`) | The scanner looks for them in the project's `node_modules` |
| **`gitleaks`** (secrets) | Global (on your `PATH`) | Works on any project |
| **`claude`** (AI review) | Global (on your `PATH`) | Optional; if absent, AI step is skipped |

### Commands by stack

**Python projects:**
```bash
pip install ruff mypy bandit pip-audit
```

**JavaScript / TypeScript / React / Next.js projects** (run *inside* the project):
```bash
npm install -D eslint prettier typescript
```

**Secret scanning (any project, one binary):**
```bash
winget install gitleaks.gitleaks     # Windows
brew install gitleaks                # macOS
# Linux: download from https://github.com/gitleaks/gitleaks/releases
```

**AI review (optional but recommended):** install Claude Code so `claude` is on
your PATH. Without it, everything still works — the AI section just says "skipped."

> You don't need all of these. With **none** installed the scanner still runs,
> skips everything gracefully, and tells you exactly what to install.

### What runs for each stack

| Check | Tool | Python | JS/TS/React/Next |
|---|---|:---:|:---:|
| Lint | `ruff` / `eslint` | ✅ | ✅ |
| Format | `ruff format --check` / `prettier --check` | ✅ | ✅ |
| Types | `mypy` / `tsc --noEmit` | ✅ | ✅ |
| Security (code) | `bandit` | ✅ | — |
| Dependencies (CVEs) | `pip-audit` / `npm audit` | ✅ | ✅ |
| Secrets | `gitleaks` | ✅ | ✅ |
| Supabase (RLS/keys/grants) | *built-in* (no tool needed) | ✅ | ✅ |
| AI review of diff | `claude` | ✅ | ✅ |

React/Next are just JS/TS to the scanner — ESLint + Prettier + TypeScript cover
them. The **Supabase** check is built into `scan.js` (pure JS, no install),
auto-skips on non-Supabase projects, and statically flags the concrete anti-patterns
a live-DB audit would catch — see [§9.4](#94-supabase-projects). See [§9](#9-configuring-it-per-project-ts--js--python--react--next) for
stack-specific tips.

---

## 6. Daily usage on your machine (local)

### Where reports land (the one thing people trip on)

- **`--path`** = the project you *scan* (defaults to the current folder).
- **Reports are written to the folder you *run the command from*** — as
  `./quality-reports/` — **not** into the scanned project.

Two comfortable ways to work:

**Option A — stand inside the project (most intuitive):**
```powershell
cd E:\path\to\my-project
qg
# report → E:\path\to\my-project\quality-reports\latest.md
```

**Option B — stand in the tool folder, scan from outside (zero-touch):**
```powershell
cd E:\MarketInk\Quality_Gate\quality-gate
node scan.js --path E:\path\to\my-project
# report → E:\MarketInk\Quality_Gate\quality-gate\quality-reports\latest.md
```

### The commands you'll actually use

```powershell
qg                       # DAILY DRIVER: scan my changed files + AI review of the diff
qg --no-ai               # faster: just linters/types/security on my changes (no AI, offline)
qg --ai-full             # DEEP review before an important PR (all 6 AI reviewers)
qg --staged              # only what I've `git add`-ed (perfect for a pre-commit hook)
qg --base v1.4.0         # everything since a release tag/branch/commit
qg --path ..\repo --all --no-ai    # one-time full audit of another repo
qg --no-report           # print to console only, write nothing anywhere
qg --strict              # exit code 1 if there are findings (for hooks/CI gating)
```

### Every flag, in plain English

| Flag | What it does | When to use |
|---|---|---|
| *(none)* | Scan changed files vs base branch + AI review of the diff | **Default. Before every commit/PR.** |
| `--path DIR` | The project to scan (default: current dir) | Scanning from outside (Option B) |
| `--all` | Scan the **whole project** (disables AI) | One-time audit only |
| `--staged` | Scan only `git add`-ed changes | Inside a pre-commit hook |
| `--base REF` | Diff against a specific tag/branch/commit | "Everything since last release" |
| `--no-ai` | Skip the Claude review | CI, offline, or "just the linters" |
| `--ai-full` | Run all 6 AI reviewers (review + security + architecture + performance + business-logic + supabase) | Deep review before a big merge |
| `--no-report` | Console only; write nothing | Truly zero-touch spot check |
| `--out DIR` | Where to write the report | Pin reports to a fixed folder |
| `--strict` | **Exit 1** if there are findings | CI gating / blocking git hooks |
| `--timeout SEC` | Per-tool timeout (default 600) | Very large repos that time out |

**Exit codes:** `0` = ran fine (even with findings). `1` = only with `--strict`
*and* there were findings. `2` = bad `--path`. This is why it's safe in CI by
default — it can't fail your build unless you opt in with `--strict`.

---

## 7. Reading the report

Every run writes three files into `quality-reports/`:

- **`latest.md`** — human-readable. **Read this one.**
- **`latest.json`** — same data, machine-readable (for dashboards/automation).
- **`report-YYYYMMDD-HHMMSS.md`** — timestamped history, one per run.

Each check has a status:

| Status | Meaning | What to do |
|---|---|---|
| **PASS** | Tool ran, found nothing | 🎉 Nothing to do |
| **FINDINGS** | Tool ran, found issues | Read the **Details** section and fix them |
| **SKIP** | Tool not installed, or nothing in scope for it | Install the tool ([§5](#5-installing-the-check-tools-per-stack)) if you want that check |
| **ERROR** | Tool crashed or timed out | See [§14](#14-troubleshooting) — usually a missing lockfile or a real timeout |
| **OFF** | Disabled in config | You turned it off in `quality-gate.config.json` |

- The **Details** section lists only `FINDINGS` and `ERROR` checks, each with the
  *exact command it ran* and the raw output — so you can reproduce it yourself.
- The **AI Review** section is Claude's prose analysis of your diff: each issue
  gets a `file:line` estimate, a severity (high/med/low), the problem in one
  sentence, and a concrete fix. If it found nothing, it says so.

---

## 8. Local vs Git vs CI — who does what

This is the part that ties everything together. The same scanner plays three
different roles depending on *where* it runs.

| Where | When it runs | What it's for | How |
|---|---|---|---|
| **Local (your machine)** | Whenever you want, before you commit/push | Fast feedback loop — fix your own issues before anyone sees them | You type `qg` |
| **Git hooks (local, automatic)** | On `git commit` / `git push` | Safety net so you don't forget to run it | Hook calls `scan.js` (see [§10](#10-automating-with-github-step-by-step)) |
| **CI (GitHub, automatic)** | On every Pull Request | Team-wide, unskippable check — the source of truth before merge | GitHub Actions workflow |

**Why both local and CI?**

- **Local** is fast and private. You catch and fix issues before they're ever
  visible. But local checks can be skipped (`--no-verify`), so they can't be the
  *only* gate.
- **CI** runs on GitHub for *everyone* on *every* PR. It can't be skipped, it's
  the shared record, and it's what a reviewer/team lead looks at before clicking
  merge. This is where "catch it before the PR merges" actually gets enforced.

Think of local as "check my own work" and CI as "the team's shared quality
record."

---

## 9. Configuring it per project (TS / JS / Python / React / Next)

There are two layers of configuration:

1. **The scanner's own config** — `quality-gate.config.json` (optional).
2. **Each tool's own config** — the normal `ruff`, `eslint`, `tsconfig`, etc.
   files that live in the project. The gate just *runs* these; it respects
   whatever rules the project already has.

### 9.1 The scanner config (`quality-gate.config.json`)

Lives next to `scan.js`. Delete it and safe defaults still apply.

```json
{
  "base_ref": null,
  "disabled_checks": []
}
```

- **`base_ref`** — default git ref to diff against. `null` = auto-detect
  (`origin/main` → `main` → …). Set it if your default branch is unusual (e.g.
  `"origin/develop"`).
- **`disabled_checks`** — check ids you never want to run. Valid ids:
  `ruff`, `ruff-format`, `mypy`, `bandit`, `pip-audit`, `eslint`, `prettier`,
  `tsc`, `npm-audit`, `gitleaks`, `supabase`.
  Example — silence npm audit and secrets: `["npm-audit", "gitleaks"]`.

### 9.2 Give Claude your project's rules — `CLAUDE.md`

This is the highest-leverage config for context-aware review. Drop a `CLAUDE.md`
at the project root and the AI review treats its rules as the standard it reviews
against. A template ships with the tool:

```bash
cp quality-gate/.quality/standards/CLAUDE.template.md  <your-project>/CLAUDE.md
```

Fill in your stack, architecture rules, API conventions, and security rules as
concrete "always/never" statements, e.g.:

```
- Never access the database directly from controllers. Always go through the service layer.
- Never build SQL by string concatenation — use parameterized queries.
- Every API endpoint validates its input before use.
- Never log secrets, tokens, or PII.
```

The more concrete the rules, the more objective and useful the AI review.

### 9.3 Stack-specific tips

**Python (FastAPI / Django / scripts):**
- Install `ruff mypy bandit pip-audit`.
- `pip-audit` triggers when it sees `requirements*.txt`, `pyproject.toml`,
  `setup.py`, or `Pipfile`.
- `bandit` is your Python security scanner (runs on changed `.py` files).

**JavaScript / TypeScript (Node backend, libraries):**
- Install `eslint prettier typescript` **as dev deps inside the project**.
- `tsc --noEmit` triggers when there's a `tsconfig.json`.
- `npm audit` triggers when there's a `package.json` — **but needs a
  `package-lock.json`** (see [§14](#14-troubleshooting)).

**React:**
- Same as JS/TS. Make sure ESLint has the React plugins the project uses
  (`eslint-plugin-react`, `eslint-plugin-react-hooks`) — the gate runs your
  existing ESLint config, so configure ESLint normally and the gate honors it.

**Next.js:**
- Same as React/TS. Next projects ship `eslint-config-next`; keep it in
  `node_modules` so the gate's ESLint picks it up.
- TypeScript check uses your `tsconfig.json` (Next generates one).
- If a Next repo has no `package-lock.json`, run `npm i --package-lock-only` once
  so `npm audit` works, or disable `npm-audit` in the config.

> **Key point:** the gate never invents rules for your stack. It runs *your*
> project's linter/type config. Configure ESLint/Ruff/tsconfig the way you
> normally would; the gate is just the thing that runs them consistently and adds
> the AI layer.

### 9.4 Supabase projects

Many of our projects use Supabase, where **Row Level Security (RLS) is the main
access control** — every table in the `public` schema is exposed over an
auto-generated REST API, and the `service_role` key bypasses RLS entirely. Generic
linters know none of this, so the gate ships a **built-in Supabase check** plus a
**Supabase AI reviewer**. Nothing to install; the check auto-detects Supabase (a
`supabase/` dir, `@supabase/*` in `package.json`, or `supabase`/`createClient` in
the scanned code) and shows `SKIP` on projects that don't use it.

**Deterministic check (`supabase`)** — the concrete "always/never" signatures,
scanned over your changed code and `.sql` migration files:

| It flags | Severity | Why |
|---|---|---|
| `service_role`/secret key behind a browser-exposed env var (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, …) | HIGH | Ships full-DB-access credentials to the client |
| A hardcoded secret key (`sb_secret_…`) or a `service_role` JWT in source | HIGH | Leaks a key that bypasses RLS |
| `service_role` referenced in a client (`'use client'`) file | HIGH | The service role must never reach the browser |
| `... disable row level security` in a migration | HIGH | Table becomes fully readable/writable with the anon key |
| `create table …` with no `enable row level security` in the same file | MEDIUM | New table left unprotected |
| `grant … to anon`/`public` (write = MEDIUM, read = LOW) | MED/LOW | Exposes data via the REST API; prefer RLS policies |
| `service_role` referenced inside a `create policy` | MEDIUM | Likely a misconfiguration — service_role already bypasses RLS |

> The anon key hardcoded in client code is **not** flagged — it's designed to be
> public. RLS, not key secrecy, is what protects your data.

**AI reviewer (`supabase`)** — runs under `qg --ai-full` and handles the judgment
calls a regex can't: RLS *coverage & correctness* (`USING (true)`, missing
`WITH CHECK`), ownership/IDOR (queries not scoped to `auth.uid()`),
`security definer` RPC functions, public storage buckets, and sensitive columns
exposed to clients.

Disable it like any other check via `quality-gate.config.json`
(`"disabled_checks": ["supabase"]`). To make the AI review context-aware, add your
Supabase rules to the project's `CLAUDE.md` (the template includes a Supabase
section — see [§9.2](#92-give-claude-your-projects-rules--claudemd)).

---

## 10. Automating with GitHub (step by step)

You have three levels of automation. Adopt them in order, as trust grows.

### Level 1 — Local pre-commit hook (advisory, never blocks)

Warns you at commit time but always lets the commit through. Create
`<project>/.git/hooks/pre-commit`:

```bash
#!/usr/bin/env bash
# Scan staged changes, print advice, never block the commit.
node /e/MarketInk/Quality_Gate/quality-gate/scan.js --staged --no-ai --no-report
exit 0   # always succeed — this is advisory
```

### Level 2 — Local pre-push hook (blocks your push on findings)

Create `<project>/.git/hooks/pre-push`:

```bash
#!/usr/bin/env bash
# Block the push if the scanner finds issues in the diff.
node /e/MarketInk/Quality_Gate/quality-gate/scan.js --no-ai --strict
# --strict makes the scanner exit 1 on findings, which aborts the push.
```

> Hooks in `.git/hooks/` aren't committed. To share them with the team, put the
> scripts in a tracked folder like `.githooks/` and run
> `git config core.hooksPath .githooks` once per clone. On Windows, hooks run via
> Git Bash, so use the `/e/...` path style shown above.

### Level 3 — CI on every Pull Request (the team standard)

A ready-made GitHub Actions workflow ships with the tool at
`.github/workflows/quality-scan.yml`. It:

- runs on **every PR** (and manual dispatch),
- scans the **PR diff** (`--base origin/<base_branch>`),
- is **`continue-on-error: true`** — it never fails the build (yet),
- uploads the report as a downloadable artifact, **and**
- **posts the report straight onto the PR as a comment** (updating the same
  comment on re-runs, so the PR stays tidy) — see [§13.1](#131-post-the-report-as-a-pr-comment-built-in).

**Set it up in a project:**

1. Copy the workflow in:
   ```powershell
   Copy-Item E:\MarketInk\Quality_Gate\quality-gate\.github\workflows\quality-scan.yml `
             E:\path\to\my-project\.github\workflows\
   ```

2. Add to the project's `.gitignore` so reports aren't committed:
   ```
   quality-reports/
   .quality-gate-tool/
   ```

3. Commit and open a PR. The workflow clones the scanner from
   `https://github.com/sarthakkk1212/quality-gate.git` at run time, scans the
   PR's diff, and **posts the results as a PR comment automatically**. (The full
   report is also downloadable as the **"quality-report"** artifact from the
   Checks tab.) For the comment to post you need repo **Settings → Actions →
   General → Workflow permissions → "Read and write permissions"** enabled — the
   workflow already declares `pull-requests: write`. Note: PRs opened *from forks*
   get a read-only token, so the comment step is skipped on those.

4. **To run the deterministic tools in CI too**, uncomment the install step in the
   workflow and list what the repo uses:
   ```yaml
   - name: Install scanners
     run: pip install ruff mypy bandit pip-audit
   ```
   (For JS/TS, add an `npm ci` step so `node_modules` exists.)

5. **Make it blocking later** — once the team trusts the signal, flip
   `continue-on-error: true` → `false` (and add `--strict`) so a PR with findings
   fails the check. **Do this only after the false-positive rate is low.**

> **AI review in CI:** the shipped workflow uses `--no-ai` because the `claude`
> CLI needs credentials to run in CI. Keep AI review local (or in a pre-push hook)
> until you set up authenticated AI in CI. See
> [§13](#13-extending-it-team-visibility-pr-comments-history-dashboards).

---

## 11. The goal: catch issues before the PR merges

This is the whole point. Here's the end-to-end flow that gets you there, tying
together everything above.

```
Developer writes code
        │
        ▼
  (local)  qg  ───────────► fix issues in your own diff, privately.  Fast loop.
        │
        ▼
  git commit ──► pre-commit hook (advisory linters)      [Level 1]
        │
        ▼
  git push   ──► pre-push hook: qg --strict blocks push  [Level 2]
        │
        ▼
  Open PR on GitHub
        │
        ▼
  (CI)  quality-scan.yml runs on the PR diff             [Level 3]
        │      → report uploaded as artifact / PR comment
        ▼
  Reviewer reads findings + AI review, requests changes if needed
        │
        ▼
  All clear → merge.  The defect never reaches main.
```

**Step-by-step to reach the goal for one project:**

1. **Install the check tools** the project uses ([§5](#5-installing-the-check-tools-per-stack)).
2. **Add the `qg` alias** so running it is one word ([§4](#4-your-first-15-minutes-onboarding)).
3. **Add a `CLAUDE.md`** with your architecture + security rules so AI review is
   context-aware ([§9.2](#92-give-claude-your-projects-rules--claudemd)).
4. **Use `qg` daily** — before every commit, fix what's in *your* diff.
5. **One-time audit** — run `qg --path . --all --no-ai` once to see the whole
   backlog, then ignore it day-to-day (clean-as-you-code).
6. **Add the pre-push hook** (Level 2) so you can't push findings by accident.
7. **Add the CI workflow** (Level 3) so *every* PR from *everyone* is scanned.
8. **Once trusted, make CI blocking** so a PR with findings can't be merged.

That final step is the literal implementation of "check and resolve before merging
the PR."

---

## 12. How to validate it's actually working

Don't take it on faith — prove it. Here are concrete checks, cheapest first.

### Check 1 — It runs and reports (smoke test, 1 min)

```bash
cd E:\MarketInk\Quality_Gate\quality-gate
node scan.js --path . --no-ai
```
✅ Expect: a summary table printed, and `quality-reports/latest.md` created. If you
see that, the engine works.

### Check 2 — It detects the tools you installed

```bash
qg --no-ai
```
✅ Expect: tools you installed show `PASS`/`FINDINGS`; tools you didn't show `SKIP`
with a note like "tool not available." If a tool you *did* install shows `SKIP`,
it's in the wrong place — re-read [§5's golden rule](#the-golden-rule-of-where-tools-live)
(JS tools must be in `node_modules`, Python tools on PATH).

### Check 3 — It actually catches a real problem (the important one)

Deliberately introduce a known issue, then confirm the gate flags it:

- **Secret:** add a line like `AWS_SECRET_KEY = "AKIAIOSFODNN7EXAMPLE..."` to a
  file → `gitleaks` should report `FINDINGS`.
- **Type error (TS):** assign a string to a `number` → `tsc` should report
  `FINDINGS`.
- **Lint error (Python):** add an unused import → `ruff` should report `FINDINGS`.
- **Logic bug (AI):** write an off-by-one or an SQL string-concatenation → the AI
  review should call it out with a `file:line` and a fix.

Then **remove the issue and re-run** — it should go back to `PASS`. If findings
appear and disappear as expected, the gate is genuinely working, not just running.

### Check 4 — Scope is correct

```bash
qg               # should list only files you changed
qg --all         # should list the whole project (and skip AI)
```
✅ Expect the changed-files run to be short and the `--all` run to be long. If both
are identical, check that you're inside a git repo with a resolvable base branch.

### Check 5 — CI works

Open a test PR after installing the workflow ([§10 Level 3](#level-3--ci-on-every-pull-request-the-team-standard)).
✅ Expect a "Quality Gate (scan)" check on the PR and a downloadable
"quality-report" artifact.

> **Reference for what a healthy report looks like:** the sample AI review in
> `quality-gate/quality-reports/latest.json` shows Claude finding 6 real, ranked
> issues (a 40s stall bug, a discarded return value, a duplicated Chrome option,
> etc.) in a scraper diff — that's the kind of context-aware output a working AI
> review produces.

---

## 13. Extending it: team visibility, PR comments, history, dashboards

Today the tool gives you **local reports**, **CI artifacts**, and **PR comments**
(§13.1 is now built in). To make history and metrics visible to the *whole team*,
here are the next steps in priority order. Each is additive — none changes the
read-only core.

### 13.1 Post the report as a PR comment (built in ✅)

**This ships in `quality-scan.yml` already** — no extra setup beyond turning on
write permissions. The workflow's "Comment report on PR" step reads
`quality-reports/latest.md` and posts it straight onto the PR, so nobody has to
download an artifact. It:

- **updates the same comment on every re-run** (tagged with a hidden
  `<!-- marketink-quality-gate -->` marker) instead of piling up new comments,
- **truncates safely** if the report exceeds GitHub's ~65k-char comment limit
  (pointing you to the full artifact),
- runs with `if: always()`, so you still get a comment even when there are
  findings.

**To enable it**, two things must be true (both one-time, per repo):

1. The workflow declares `pull-requests: write` — ✅ already added.
2. Repo **Settings → Actions → General → Workflow permissions** must be set to
   **"Read and write permissions"**. If your org defaults to read-only, the
   permission line alone won't be enough.

**Limitation:** PRs opened *from forks* get a read-only token from GitHub for
security, so the comment step is silently skipped there (the artifact still
uploads). It works for branches pushed to the same repo. Supporting fork PRs would
require a `pull_request_target` workflow, which needs extra care — not enabled by
default.

This is the single biggest "everyone can see it" win, and it's live now.

### 13.2 Keep history

- **Timestamped reports** already exist locally (`report-YYYYMMDD-HHMMSS.md`).
- **In CI**, artifacts are retained per-run automatically (GitHub keeps them for
  the repo's retention window) — that's your run history.
- For a durable archive, add a step that pushes each `latest.json` to a dedicated
  `quality-history` branch or an external bucket, keyed by PR number and commit
  SHA.

### 13.3 A team dashboard

Because every run emits a structured `latest.json`
(`{ meta, checks, reviews }`), you can build a simple dashboard on top of it
without touching the scanner:

- Collect each PR's `latest.json` (from the archive above).
- Track the metrics that prove value: **defects caught before merge** (per layer),
  **escaped defects** (found in prod that a gate should have caught), **AI
  false-positive rate**, and **`--no-verify` frequency** (high = gates too
  slow/noisy).
- Render it as a static page or a small internal app.

### 13.4 AI review in CI (context-aware review on every PR)

The shipped CI uses `--no-ai` because `claude` needs credentials. To enable AI in
CI: install Claude Code in the workflow, provide its API credentials via GitHub
**Secrets**, and drop the `--no-ai` flag. Combined with §13.1, every PR then gets
Claude's context-aware review posted automatically — the fullest form of the goal.

### 13.5 One source of truth (avoid drift)

As adoption grows, keep the scanner, prompts, and `CLAUDE.template.md` in the
single `quality-gate` repo and have every project reference it (CI already clones
it at run time). Improve a prompt once → every project benefits. Don't copy
`scan.js` into each repo by hand.

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **Everything Python shows `SKIP`** | Those tools aren't installed / not on PATH | `pip install ruff mypy bandit pip-audit` |
| **A JS tool shows `SKIP`** even though it's installed globally | JS tools must be **local** to the project | `npm install -D eslint prettier typescript` inside the project |
| **`npm audit` → ERROR `ENOLOCK`** | No `package-lock.json` | `npm i --package-lock-only` once, or disable `npm-audit` in config |
| **`tsc` says "Could not find a declaration file for 'pg'"** | Real project gap, not a scanner bug | `npm i -D @types/pg` (the gate faithfully reports your `tsc` output) |
| **AI review says "skipped"** | `claude` not on PATH, **or** you used `--all`, **or** the diff is empty | Install Claude Code; drop `--all` (AI is diff-based) |
| **"not a git repository — scanning the whole project"** | You're outside a git repo | Expected; it falls back to `--all` automatically |
| **A tool timed out (`ERROR`)** | Very large repo | Raise it: `qg --timeout 1200` |
| **First run floods me with issues** | You used `--all` on a legacy repo | Drop `--all` — the default scans only *your* changes |
| **Report didn't appear** | You used `--no-report`, or the out dir wasn't writable | Remove `--no-report`, or set `--out` to a writable folder |

> **Remember:** a `SKIP` or `ERROR` never means the scanner failed — it means a
> *tool* was missing or a *project* has a gap. The scanner cannot break your build
> and made no changes to your code.

---

## 15. One-page cheat sheet

```
# --- daily (local) ---
qg                          # scan my changes + AI review  ← use this most
qg --no-ai                  # faster, offline, just linters/types/security
qg --ai-full                # deep 6-reviewer AI pass before an important PR
qg --staged                 # only staged changes (pre-commit)
qg --base v1.4.0            # everything since a release
qg --path ..\repo --all --no-ai   # one-time full audit of another repo
qg --strict                 # exit 1 on findings (hooks / CI gating)
qg --no-report              # console only, write nothing

# --- what it is ---
# qg = node E:\MarketInk\Quality_Gate\quality-gate\scan.js
# Report → ./quality-reports/latest.md (in the folder you ran it from)
# READ-ONLY: never edits code, never touches git, never installs anything.

# --- install tools (only what a project uses) ---
pip install ruff mypy bandit pip-audit          # Python (on PATH)
npm install -D eslint prettier typescript       # JS/TS/React/Next (in project)
winget install gitleaks.gitleaks                # secrets (on PATH)
# + Claude Code on PATH for AI review

# --- statuses ---
PASS = clean   FINDINGS = fix these   SKIP = tool missing / nothing in scope
ERROR = tool crashed/timed out   OFF = disabled in config

# --- automate ---
# Level 1: .git/hooks/pre-commit  → advisory (never blocks)
# Level 2: .git/hooks/pre-push    → qg --strict (blocks push on findings)
# Level 3: .github/workflows/quality-scan.yml → runs on every PR
```

---

## 16. What's built today vs. on the roadmap

Being honest about this keeps expectations right.

**Built and working today:**
- ✅ `scan.js` — read-only scanner (Node, zero deps) with 11 deterministic checks + Claude AI review.
- ✅ **Built-in Supabase check** — static RLS / service-role-key / anon-grant
  detection over code + `.sql` migrations, plus a dedicated AI reviewer
  ([§9.4](#94-supabase-projects)). No install, auto-skips non-Supabase projects.
- ✅ Wrappers (`quality.ps1`, `quality`), optional config, 6 AI prompt reviewers.
- ✅ `CLAUDE.template.md` standards template.
- ✅ GitHub Actions CI workflow (non-blocking, uploads artifact).
- ✅ **PR-comment posting** — the workflow comments the report on every PR and
  updates the same comment on re-runs ([§13.1](#131-post-the-report-as-a-pr-comment-built-in)).
- ✅ Markdown + JSON + timestamped reports.

**Roadmap (described in `QUALITY_GATE_PLAYBOOK.md`, not yet in `scan.js`):**
- ⏳ A `quality init` command that bootstraps a project automatically.
- ⏳ A three-level `quality quick / review / release` CLI wrapper.
- ⏳ `.claude/commands/` slash-command reviewers and a pre-commit-framework config.
- ⏳ AI-in-CI (Claude review on every PR) and a metrics dashboard (see [§13](#13-extending-it-team-visibility-pr-comments-history-dashboards)).

For the *vision and the evidence behind it*, read `QUALITY_GATE_PLAYBOOK.md` (the
"how" at design level) and `RESEARCH_PAPER.md` (the "why"). **This handbook is the
practical, use-it-today guide** — start here, and reach for those when you want the
bigger picture.

---

*Read-only by design. It tells you what's wrong; it never touches your code, your
git history, or your dependencies. The worst it can do is write a report.*
