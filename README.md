# MarketInk Quality Gate

A **read-only code scanner** that runs your existing quality tools (linters,
type checkers, security & dependency scanners) plus an optional scoped **AI
review** with Claude, and produces one clean report.

It is designed to be safe to run on **any project, at any time** — including
production repos — because it **never changes anything**.

---

## Safety guarantees

- ✅ **Never edits, formats, or fixes your code.** Every tool runs in check-only
  mode (`ruff check --no-fix`, `prettier --check`, `mypy`, `npm audit`,
  `gitleaks detect`, …). There are no `--fix`/`--write` flags anywhere.
- ✅ **Never changes git state.** No add, commit, push, or checkout.
- ✅ **Never installs anything.** It only runs tools already available.
- ✅ **Can't break a build.** A missing tool is *skipped*, not failed. Exit code
  is `0` by default; `--strict` (opt-in) is the only way it returns non-zero.
- ✅ **Zero-touch on the scanned project.** Point it at a repo from outside with
  `--path`; nothing is written into that repo. The only file it ever writes is a
  report, in an output folder you choose — or nothing at all with `--no-report`.

---

## Requirements

**Node.js 18+ and nothing else** (Node 20+ recommended). The scanner is a single
dependency-free script — zero npm packages, Node built-ins only, so `node scan.js`
just works with no `npm install`. The actual checks are optional and
auto-detected — install whichever a project uses (see
[INTEGRATION.md](INTEGRATION.md)); the gate runs what's there and skips the rest.

> The language the tool is *written in* is unrelated to the languages it *scans*.
> It's an orchestrator: it shells out to `ruff`/`mypy`/`bandit`/`pip-audit` for
> Python projects and `eslint`/`prettier`/`tsc`/`npm audit` for JS/TS projects,
> exactly the same way regardless of which stack it runs on.

---

## Quick start

```bash
# Scan the changed files in the current repo:
node scan.js

# Zero-touch scan of another project (nothing written into it):
node scan.js --path ../some-service

# Full health check of the whole project:
node scan.js --all
```

On Windows you can use `./quality.ps1 --all`; on macOS/Linux `./quality --all`.

---

## What it runs

| Check | Tool | Mode | Scope |
|---|---|---|---|
| Lint (Python) | `ruff check` | read-only | changed files |
| Format (Python) | `ruff format --check` | read-only | changed files |
| Types (Python) | `mypy` | read-only | changed files |
| Security (Python) | `bandit` | read-only | changed files |
| Dependencies (Python) | `pip-audit` | read-only | project |
| Lint (JS/TS) | `eslint` | read-only | changed files |
| Format (JS/TS) | `prettier --check` | read-only | changed files |
| Types (JS/TS) | `tsc --noEmit` | read-only | project |
| Dependencies (JS/TS) | `npm audit` | read-only | project |
| Secrets | `gitleaks detect` | read-only | working tree |
| Supabase (RLS/keys/grants) | *built-in* (no tool) | read-only | changed code + `.sql` |
| AI review | `claude -p` | read-only | the diff |

Deterministic tools own anything mechanical. The AI review is reserved for
judgment — security, business logic, architecture, performance,
maintainability — and is **scoped to the diff** and run in an isolated temp
directory so it has nothing in your project to touch.

---

## Options

```
--path PATH     repo to scan (default: current directory)
--all           scan the whole project instead of just changes
--staged        scan only git-staged changes
--base REF      git base ref for the diff (default: auto-detect origin/main…)
--no-ai         skip the AI review
--ai-full       run all specialized AI reviewers (security/arch/perf/logic/supabase)
--no-report     print to the console only; write no files anywhere
--out DIR       report output directory (default: ./quality-reports)
--strict        exit 1 if any findings (for optional CI gating)
--timeout SEC   per-tool timeout (default: 600)
```

## How scope is decided

- In a git repo, it scans **changed files vs the base branch** by default
  (auto-detects `origin/main`, `main`, …). This keeps reports focused and is why
  it's safe on large existing codebases — you see issues in *new* code, not a
  wall of legacy noise (the "clean as you code" principle).
- `--all` scans everything; `--staged` scans staged changes only.
- Not a git repo? It automatically falls back to `--all`.

## Configuration (optional)

`quality-gate.config.json` lets you set a default `base_ref` and disable checks
by id. Delete the file and the scanner still works with safe defaults.

---

See **[INTEGRATION.md](INTEGRATION.md)** for step-by-step setup on new and
existing projects, installing the underlying tools, and CI.
