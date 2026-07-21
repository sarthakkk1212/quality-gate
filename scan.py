#!/usr/bin/env python3
"""
MarketInk Quality Gate — a read-only, non-destructive code scanner.

WHAT IT DOES
    Runs deterministic quality tools (linters, type checkers, security &
    dependency scanners) in *check-only* mode, plus an optional scoped AI
    review with Claude, and produces a report.

WHAT IT WILL NEVER DO  (safety guarantees)
    * It NEVER edits, formats, or fixes your source code.
    * It NEVER changes git state (no add/commit/push/checkout).
    * It NEVER installs anything.
    * Every tool is invoked in read-only / --check mode only.
    * A missing tool is skipped, never an error. It cannot break a build.
    * The ONLY thing it writes is a report file, in an output directory you
      choose (or nothing at all with --no-report).

REQUIREMENTS
    Python 3.8+. Nothing else. Each scanner is optional and auto-detected;
    the gate only runs the tools a project already has available.

USAGE
    python scan.py                         # scan changed files in current repo
    python scan.py --path ../other-repo    # zero-touch scan of another repo
    python scan.py --all                   # scan the whole project
    python scan.py --staged                # scan only git-staged changes
    python scan.py --no-ai                 # skip the AI review
    python scan.py --strict                # exit 1 if findings (for optional CI)
    python scan.py --no-report             # print only; write nothing anywhere
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# --------------------------------------------------------------------------- #
#  File type groups
# --------------------------------------------------------------------------- #
PY_EXT = (".py",)
JS_EXT = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx")
PRETTIER_EXT = JS_EXT + (".json", ".css", ".scss", ".md", ".yaml", ".yml", ".html")

# Directories never worth scanning (used only for --all file discovery).
IGNORE_DIRS = {
    ".git", "node_modules", ".venv", "venv", "env", "__pycache__",
    "dist", "build", ".next", ".nuxt", "coverage", ".mypy_cache",
    ".ruff_cache", ".pytest_cache", "vendor", ".tox",
}

IS_WIN = os.name == "nt"

# ANSI colors (auto-disabled when not a TTY or on Windows without support).
class C:
    ok = "\033[32m"; warn = "\033[33m"; bad = "\033[31m"; dim = "\033[90m"
    bold = "\033[1m"; cyan = "\033[36m"; end = "\033[0m"

def _no_color():
    for a in ("ok", "warn", "bad", "dim", "bold", "cyan", "end"):
        setattr(C, a, "")

if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    _no_color()

# Best-effort UTF-8 console so output is clean on every terminal.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# --------------------------------------------------------------------------- #
#  Subprocess helper — always safe, never raises
# --------------------------------------------------------------------------- #
def run(argv, cwd, timeout=600, stdin=None):
    """Run a command read-only. Returns (returncode_or_status, combined_output).

    returncode is an int on normal completion, or one of the strings
    'missing' / 'timeout' / 'error' when the command could not run.
    """
    try:
        p = subprocess.run(
            argv, cwd=cwd, input=stdin, timeout=timeout,
            capture_output=True, text=True, errors="replace",
        )
        out = (p.stdout or "")
        if p.stderr:
            out += ("\n" if out else "") + p.stderr
        return p.returncode, out.strip()
    except FileNotFoundError:
        return "missing", "executable not found"
    except subprocess.TimeoutExpired:
        return "timeout", f"timed out after {timeout}s"
    except Exception as exc:  # never let a tool crash the scanner
        return "error", f"{type(exc).__name__}: {exc}"


# --------------------------------------------------------------------------- #
#  Git helpers (read-only). cwd is always the target repo.
# --------------------------------------------------------------------------- #
def git(args, target):
    rc, out = run(["git", *args], target, timeout=60)
    return out if rc == 0 else ""

def is_git_repo(target):
    rc, _ = run(["git", "rev-parse", "--is-inside-work-tree"], target, timeout=30)
    return rc == 0

def resolve_base(target, base):
    if base:
        return base
    for cand in ("origin/main", "origin/master", "main", "master"):
        rc, _ = run(["git", "rev-parse", "--verify", cand], target, timeout=30)
        if rc == 0:
            return cand
    return None

def changed_files(target, base, staged):
    """Return a list of repo-relative paths that changed (and still exist)."""
    found = set()

    def add(text):
        for line in text.splitlines():
            line = line.strip()
            if line:
                found.add(line)

    if staged:
        add(git(["diff", "--name-only", "--cached"], target))
    else:
        if base:
            add(git(["diff", "--name-only", f"{base}...HEAD"], target))
        add(git(["diff", "--name-only", "HEAD"], target))           # unstaged
        add(git(["diff", "--name-only", "--cached"], target))        # staged
        add(git(["ls-files", "--others", "--exclude-standard"], target))  # untracked

    return sorted(f for f in found if os.path.isfile(os.path.join(target, f)))

def walk_files(target):
    """Discover all source files for --all mode, honoring IGNORE_DIRS."""
    out = []
    for root, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), target)
            out.append(rel.replace(os.sep, "/"))
    return out


# --------------------------------------------------------------------------- #
#  Tool resolution
# --------------------------------------------------------------------------- #
def global_bin(name):
    return shutil.which(name)

def local_bin(target, name):
    """Resolve a JS tool from the project's own node_modules/.bin."""
    d = os.path.join(target, "node_modules", ".bin")
    cands = [name + ".cmd", name] if IS_WIN else [name]
    for c in cands:
        p = os.path.join(d, c)
        if os.path.isfile(p):
            return p
    return None


# --------------------------------------------------------------------------- #
#  Check specifications
#  level: "file" (runs on matching files) | "repo" (runs once if triggered)
#  Every argv is READ-ONLY. Do not ever add fix/write flags here.
# --------------------------------------------------------------------------- #
def build_specs():
    return [
        # ---- Python ----
        dict(id="ruff", title="Ruff - lint", cat="lint", lang="python",
             level="file", exts=PY_EXT,
             resolve=lambda t: global_bin("ruff"),
             argv=lambda e, f: [e, "check", "--no-fix", "--force-exclude", *f]),

        dict(id="ruff-format", title="Ruff - format check", cat="format", lang="python",
             level="file", exts=PY_EXT,
             resolve=lambda t: global_bin("ruff"),
             argv=lambda e, f: [e, "format", "--check", "--force-exclude", *f]),

        dict(id="mypy", title="mypy - types", cat="types", lang="python",
             level="file", exts=PY_EXT,
             resolve=lambda t: global_bin("mypy"),
             argv=lambda e, f: [e, "--no-error-summary", *f]),

        dict(id="bandit", title="Bandit - security", cat="security", lang="python",
             level="file", exts=PY_EXT,
             resolve=lambda t: global_bin("bandit"),
             argv=lambda e, f: [e, "-q", "-ll"] + (["-r", "."] if f == ["."] else list(f))),

        dict(id="pip-audit", title="pip-audit - dependencies", cat="deps", lang="python",
             level="repo", trigger=["requirements*.txt", "pyproject.toml", "setup.py", "Pipfile"],
             resolve=lambda t: global_bin("pip-audit"),
             argv=lambda e, f: [e]),

        # ---- JavaScript / TypeScript ----
        dict(id="eslint", title="ESLint - lint", cat="lint", lang="js",
             level="file", exts=JS_EXT,
             resolve=lambda t: local_bin(t, "eslint"),
             argv=lambda e, f: [e, "--no-error-on-unmatched-pattern", *f]),

        dict(id="prettier", title="Prettier - format check", cat="format", lang="js",
             level="file", exts=PRETTIER_EXT,
             resolve=lambda t: local_bin(t, "prettier"),
             argv=lambda e, f: [e, "--check", "--ignore-unknown", *f]),

        dict(id="tsc", title="TypeScript - types", cat="types", lang="js",
             level="repo", trigger=["tsconfig.json"],
             resolve=lambda t: local_bin(t, "tsc"),
             argv=lambda e, f: [e, "--noEmit", "--pretty", "false"]),

        dict(id="npm-audit", title="npm audit - dependencies", cat="deps", lang="js",
             level="repo", trigger=["package.json"],
             resolve=lambda t: global_bin("npm"),
             argv=lambda e, f: [e, "audit", "--audit-level=high"]),

        # ---- Cross-cutting ----
        dict(id="gitleaks", title="Gitleaks - secrets", cat="security", lang="any",
             level="repo", trigger=["*"],
             resolve=lambda t: global_bin("gitleaks"),
             argv=lambda e, f: [e, "detect", "--no-git", "--no-banner",
                                "--redact", "--source", "."]),
    ]


def repo_triggered(target, patterns):
    root = Path(target)
    for pat in patterns:
        if pat == "*":
            return True
        if any(root.glob(pat)):
            return True
    return False


# --------------------------------------------------------------------------- #
#  Running the deterministic checks
# --------------------------------------------------------------------------- #
def status_from(rc):
    if rc == "missing":
        return "SKIP"
    if rc in ("timeout", "error"):
        return "ERROR"
    if rc == 0:
        return "PASS"
    return "FINDINGS"

def run_checks(target, files, scope_all, disabled, timeout):
    results = []
    for spec in build_specs():
        if spec["id"] in disabled:
            results.append(_result(spec, "OFF", "disabled in config", None, None))
            continue

        exe = spec["resolve"](target)
        if not exe:
            where = "in node_modules" if spec["lang"] == "js" and spec["level"] == "file" \
                else "on PATH"
            results.append(_result(spec, "SKIP", f"tool not available {where}", None, None))
            continue

        # Determine the argument set for this check.
        if spec["level"] == "repo":
            if not repo_triggered(target, spec.get("trigger", ["*"])):
                results.append(_result(spec, "SKIP", "not applicable to this project", None, None))
                continue
            argv = spec["argv"](exe, ["."])
        else:  # file-level
            if scope_all:
                argv = spec["argv"](exe, ["."])
            else:
                subset = [f for f in files if f.lower().endswith(spec["exts"])]
                if not subset:
                    results.append(_result(spec, "SKIP", "no matching files in scope", None, None))
                    continue
                argv = spec["argv"](exe, subset)

        rc, out = run(argv, target, timeout=timeout)
        results.append(_result(spec, status_from(rc), None, out, argv))
    return results

def _result(spec, status, note, output, argv):
    return {
        "id": spec["id"], "title": spec["title"], "category": spec["cat"],
        "status": status, "note": note, "output": output or "",
        "command": " ".join(argv) if argv else None,
    }


# --------------------------------------------------------------------------- #
#  AI review (optional, read-only, isolated)
# --------------------------------------------------------------------------- #
def collect_diff(target, base, staged, max_chars=60000):
    if staged:
        diff = git(["diff", "--cached"], target)
    else:
        diff = ""
        if base:
            diff = git(["diff", f"{base}...HEAD"], target)
        working = git(["diff", "HEAD"], target)
        if working:
            diff = (diff + "\n" + working) if diff else working
    diff = diff.strip()
    if len(diff) > max_chars:
        diff = diff[:max_chars] + "\n\n[... diff truncated for review ...]"
    return diff

def ai_review(scanner_dir, target, diff, run_all, timeout):
    claude = global_bin("claude")
    if not claude:
        return [{"prompt": "review", "status": "SKIP",
                 "output": "Claude CLI not found on PATH — AI review skipped."}]
    if not diff:
        return [{"prompt": "review", "status": "SKIP",
                 "output": "No diff in scope — nothing for AI to review."}]

    prompt_dir = Path(scanner_dir) / ".quality" / "prompts"
    names = ["review"]
    if run_all:
        names = ["review", "security", "architecture", "performance", "business-logic"]

    reviews = []
    # Run Claude in a throwaway directory so it has NOTHING in the target to touch.
    with tempfile.TemporaryDirectory() as tmp:
        for name in names:
            pf = prompt_dir / f"{name}.md"
            if not pf.is_file():
                continue
            instructions = pf.read_text(encoding="utf-8", errors="replace")
            full = (
                instructions
                + "\n\n---\nYou are operating in READ-ONLY review mode. Do not attempt "
                  "to modify, create, or run anything — only report findings.\n\n"
                  "Here is the unified diff to review:\n\n```diff\n"
                + diff + "\n```\n"
            )
            rc, out = run([claude, "-p"], tmp, timeout=timeout, stdin=full)
            reviews.append({
                "prompt": name,
                "status": "PASS" if rc == 0 else "ERROR",
                "output": out or "(no output)",
            })
    if not reviews:
        reviews.append({"prompt": "review", "status": "SKIP",
                        "output": f"No prompt files found in {prompt_dir}."})
    return reviews


# --------------------------------------------------------------------------- #
#  Reporting
# --------------------------------------------------------------------------- #
STATUS_ICON = {
    "PASS": "PASS", "FINDINGS": "FIND", "SKIP": "skip",
    "ERROR": "ERR ", "OFF": "off ",
}
STATUS_COLOR = {
    "PASS": C.ok, "FINDINGS": C.bad, "ERROR": C.warn,
    "SKIP": C.dim, "OFF": C.dim,
}

def print_console(meta, checks, reviews):
    print()
    print(f"{C.bold}{C.cyan}MarketInk Quality Gate{C.end}  {C.dim}(read-only scanner){C.end}")
    print(f"{C.dim}target : {meta['target']}{C.end}")
    print(f"{C.dim}scope  : {meta['scope']}  - files in scope: {meta['file_count']}{C.end}")
    print(f"{C.dim}time   : {meta['time']}{C.end}")
    print("-" * 60)

    for r in checks:
        color = STATUS_COLOR.get(r["status"], "")
        label = STATUS_ICON.get(r["status"], r["status"])
        line = f"  {color}[{label}]{C.end}  {r['title']}"
        if r["note"]:
            line += f"  {C.dim}- {r['note']}{C.end}"
        print(line)

    if reviews:
        print()
        print(f"  {C.cyan}AI review{C.end}")
        for rv in reviews:
            color = C.ok if rv["status"] == "PASS" else C.warn if rv["status"] == "ERROR" else C.dim
            print(f"  {color}[{rv['status'].lower():4}]{C.end}  claude -{rv['prompt']}")

    print("-" * 60)
    findings = [r for r in checks if r["status"] == "FINDINGS"]
    errors = [r for r in checks if r["status"] == "ERROR"]
    passed = [r for r in checks if r["status"] == "PASS"]
    print(f"  {C.ok}{len(passed)} passed{C.end}  - "
          f"{C.bad}{len(findings)} with findings{C.end}  - "
          f"{C.warn}{len(errors)} errors{C.end}  - "
          f"{C.dim}{len(checks) - len(passed) - len(findings) - len(errors)} skipped{C.end}")
    if meta.get("report_path"):
        print(f"  {C.dim}full report: {meta['report_path']}{C.end}")
    print(f"  {C.dim}This scanner made no changes to your code.{C.end}")
    print()

def build_markdown(meta, checks, reviews):
    lines = []
    lines.append("# Quality Gate Report")
    lines.append("")
    lines.append(f"- **Target:** `{meta['target']}`")
    lines.append(f"- **Scope:** {meta['scope']} ({meta['file_count']} files)")
    lines.append(f"- **Generated:** {meta['time']}")
    lines.append(f"- **Mode:** read-only scan — no files were modified")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("| Check | Category | Status | Note |")
    lines.append("|---|---|---|---|")
    for r in checks:
        lines.append(f"| {r['title']} | {r['category']} | {r['status']} | {r['note'] or ''} |")
    lines.append("")

    detail = [r for r in checks if r["status"] in ("FINDINGS", "ERROR")]
    if detail:
        lines.append("## Details")
        lines.append("")
        for r in detail:
            lines.append(f"### {r['title']} — {r['status']}")
            if r["command"]:
                lines.append(f"`{r['command']}`")
            lines.append("")
            body = r["output"] or "(no output)"
            body = "\n".join(body.splitlines()[:500])
            lines.append("```")
            lines.append(body)
            lines.append("```")
            lines.append("")

    if reviews:
        lines.append("## AI Review")
        lines.append("")
        for rv in reviews:
            lines.append(f"### Claude - {rv['prompt']} - {rv['status']}")
            lines.append("")
            lines.append(rv["output"])
            lines.append("")

    return "\n".join(lines)


# --------------------------------------------------------------------------- #
#  Main
# --------------------------------------------------------------------------- #
def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Read-only quality scanner. Never modifies your code.")
    ap.add_argument("--path", default=".", help="repo to scan (default: current dir)")
    ap.add_argument("--all", action="store_true", help="scan the whole project, not just changes")
    ap.add_argument("--staged", action="store_true", help="scan only git-staged changes")
    ap.add_argument("--base", default=None, help="git base ref for the diff (default: auto)")
    ap.add_argument("--no-ai", action="store_true", help="skip the AI review")
    ap.add_argument("--ai-full", action="store_true", help="run all specialized AI reviewers")
    ap.add_argument("--no-report", action="store_true", help="print only; write no files")
    ap.add_argument("--out", default=None, help="report output dir (default: ./quality-reports)")
    ap.add_argument("--strict", action="store_true", help="exit 1 if findings (for optional CI)")
    ap.add_argument("--timeout", type=int, default=600, help="per-tool timeout in seconds")
    args = ap.parse_args(argv)

    target = os.path.abspath(args.path)
    scanner_dir = Path(__file__).resolve().parent
    if not os.path.isdir(target):
        print(f"error: path not found: {target}", file=sys.stderr)
        return 2

    # Optional config (fully optional; safe defaults if absent).
    disabled = set()
    cfg_path = scanner_dir / "quality-gate.config.json"
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            disabled = set(cfg.get("disabled_checks", []))
            if args.base is None:
                args.base = cfg.get("base_ref")
        except Exception:
            pass  # a broken config must never break the scan

    git_ok = is_git_repo(target)
    scope_all = args.all or not git_ok
    if not git_ok and not args.all:
        print(f"{C.warn}note: not a git repository - scanning the whole project.{C.end}")

    base = resolve_base(target, args.base) if git_ok and not args.all else None

    if scope_all:
        files = walk_files(target)
        scope_desc = "whole project"
    else:
        files = changed_files(target, base, args.staged)
        scope_desc = f"staged changes" if args.staged else f"changed vs {base or 'working tree'}"

    checks = run_checks(target, files, scope_all, disabled, args.timeout)

    reviews = []
    if not args.no_ai:
        diff = "" if scope_all else collect_diff(target, base, args.staged)
        if scope_all:
            reviews = [{"prompt": "review", "status": "SKIP",
                        "output": "AI review is diff-based; use a scoped scan (not --all) for AI."}]
        else:
            reviews = ai_review(scanner_dir, target, diff, args.ai_full, args.timeout)

    meta = {
        "target": target,
        "scope": scope_desc,
        "file_count": len(files),
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "report_path": None,
    }

    # Write report (the only thing this tool ever writes).
    if not args.no_report:
        out_dir = Path(args.out) if args.out else (Path.cwd() / "quality-reports")
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            md = build_markdown(meta, checks, reviews)
            (out_dir / f"report-{stamp}.md").write_text(md, encoding="utf-8")
            (out_dir / "latest.md").write_text(md, encoding="utf-8")
            (out_dir / "latest.json").write_text(
                json.dumps({"meta": meta, "checks": checks, "reviews": reviews},
                           indent=2), encoding="utf-8")
            meta["report_path"] = str(out_dir / "latest.md")
        except Exception as exc:
            print(f"{C.warn}note: could not write report ({exc}); printing only.{C.end}")

    print_console(meta, checks, reviews)

    if args.strict and any(r["status"] == "FINDINGS" for r in checks):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
