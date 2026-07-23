#!/usr/bin/env node
/*
 * MarketInk Quality Gate — a read-only, non-destructive code scanner.
 *
 * WHAT IT DOES
 *     Runs deterministic quality tools (linters, type checkers, security &
 *     dependency scanners) in *check-only* mode, plus an optional scoped AI
 *     review with Claude, and produces a report.
 *
 * WHAT IT WILL NEVER DO  (safety guarantees)
 *     * It NEVER edits, formats, or fixes your source code.
 *     * It NEVER changes git state (no add/commit/push/checkout).
 *     * It NEVER installs anything.
 *     * Every tool is invoked in read-only / --check mode only.
 *     * A missing tool is skipped, never an error. It cannot break a build.
 *     * The ONLY thing it writes is a report file, in an output directory you
 *       choose (or nothing at all with --no-report).
 *
 * REQUIREMENTS
 *     Node.js 18+ (for util.parseArgs). Nothing else — zero npm dependencies,
 *     Node built-ins only. Each scanner is optional and auto-detected; the gate
 *     only runs the tools a project already has available.
 *
 *     The language this tool is *written in* has nothing to do with the
 *     languages it *scans*: it is an orchestrator that shells out to whatever
 *     tools a project has (ruff/mypy/bandit for Python, eslint/prettier/tsc for
 *     JS/TS, gitleaks for secrets). Node being everywhere is the only reason it
 *     is in Node instead of Python.
 *
 * USAGE
 *     node scan.js                         # scan changed files in current repo
 *     node scan.js --path ../other-repo    # zero-touch scan of another repo
 *     node scan.js --all                   # scan the whole project
 *     node scan.js --staged                # scan only git-staged changes
 *     node scan.js --no-ai                 # skip the AI review
 *     node scan.js --strict                # exit 1 if findings (for optional CI)
 *     node scan.js --no-report             # print only; write nothing anywhere
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseArgs } = require("util");

// --------------------------------------------------------------------------- //
//  File type groups
// --------------------------------------------------------------------------- //
const PY_EXT = [".py"];
const JS_EXT = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];
const PRETTIER_EXT = JS_EXT.concat([".json", ".css", ".scss", ".md", ".yaml", ".yml", ".html"]);

// Directories never worth scanning (used only for --all file discovery).
const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "env", "__pycache__",
  "dist", "build", ".next", ".nuxt", "coverage", ".mypy_cache",
  ".ruff_cache", ".pytest_cache", "vendor", ".tox",
]);

const IS_WIN = os.platform() === "win32";

// Helper: does a path end with one of the given extensions (case-insensitive)?
function endsWithExt(rel, exts) {
  const low = rel.toLowerCase();
  return exts.some((e) => low.endsWith(e));
}

// --------------------------------------------------------------------------- //
//  ANSI colors (auto-disabled when not a TTY or when NO_COLOR is set)
// --------------------------------------------------------------------------- //
const C = {
  ok: "\x1b[32m", warn: "\x1b[33m", bad: "\x1b[31m", dim: "\x1b[90m",
  bold: "\x1b[1m", cyan: "\x1b[36m", end: "\x1b[0m",
};

function noColor() {
  for (const a of ["ok", "warn", "bad", "dim", "bold", "cyan", "end"]) C[a] = "";
}

if (!process.stdout.isTTY || process.env.NO_COLOR) {
  noColor();
}

// --------------------------------------------------------------------------- //
//  Subprocess helper — always safe, never raises
// --------------------------------------------------------------------------- //
// Quote a single token for the Windows cmd shell (only used for .cmd/.bat).
function quoteWin(token) {
  if (token === "") return '""';
  if (/[\s&|()<>^"%!]/.test(token)) {
    return '"' + token.replace(/"/g, '\\"') + '"';
  }
  return token;
}

/**
 * Run a command read-only. Returns [rcOrStatus, combinedOutput].
 *
 * rcOrStatus is a number on normal completion, or one of the strings
 * 'missing' / 'timeout' / 'error' when the command could not run.
 *
 * timeoutMs is in MILLISECONDS (Node convention). Callers convert seconds.
 */
function run(argv, cwd, timeoutMs = 600000, stdin = null) {
  const cmd = argv[0];
  const args = argv.slice(1);
  // Node 18.20+/20.12+ refuse to spawn .cmd/.bat without a shell (EINVAL),
  // so npm/eslint/prettier/tsc shims on Windows must go through the shell.
  const needsShell = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
  const opts = {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  };
  if (stdin != null) opts.input = stdin;

  let p;
  if (needsShell) {
    const line = [cmd, ...args].map(quoteWin).join(" ");
    p = spawnSync(line, { ...opts, shell: true });
  } else {
    p = spawnSync(cmd, args, opts);
  }

  if (p.error) {
    if (p.error.code === "ENOENT") return ["missing", "executable not found"];
    if (p.error.code === "ETIMEDOUT") return ["timeout", `timed out after ${Math.round(timeoutMs / 1000)}s`];
    return ["error", `${p.error.code || p.error.name}: ${p.error.message}`];
  }
  if (p.signal === "SIGTERM") {
    return ["timeout", `timed out after ${Math.round(timeoutMs / 1000)}s`];
  }

  let out = p.stdout || "";
  if (p.stderr) out += (out ? "\n" : "") + p.stderr;
  return [p.status, out.trim()];
}

// --------------------------------------------------------------------------- //
//  Git helpers (read-only). cwd is always the target repo.
// --------------------------------------------------------------------------- //
function git(args, target) {
  const [rc, out] = run(["git", ...args], target, 60000);
  return rc === 0 ? out : "";
}

function isGitRepo(target) {
  const [rc] = run(["git", "rev-parse", "--is-inside-work-tree"], target, 30000);
  return rc === 0;
}

function resolveBase(target, base) {
  if (base) return base;
  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    const [rc] = run(["git", "rev-parse", "--verify", cand], target, 30000);
    if (rc === 0) return cand;
  }
  return null;
}

function changedFiles(target, base, staged) {
  const found = new Set();

  const add = (text) => {
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (line) found.add(line);
    }
  };

  if (staged) {
    add(git(["diff", "--name-only", "--cached"], target));
  } else {
    if (base) add(git(["diff", "--name-only", `${base}...HEAD`], target));
    add(git(["diff", "--name-only", "HEAD"], target));            // unstaged
    add(git(["diff", "--name-only", "--cached"], target));         // staged
    add(git(["ls-files", "--others", "--exclude-standard"], target)); // untracked
  }

  return [...found]
    .filter((f) => {
      try {
        return fs.statSync(path.join(target, f)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function walkFiles(target) {
  // Discover all source files for --all mode, honoring IGNORE_DIRS.
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        walk(full);
      } else if (ent.isFile()) {
        const rel = path.relative(target, full).split(path.sep).join("/");
        out.push(rel);
      }
    }
  };
  walk(target);
  return out;
}

// --------------------------------------------------------------------------- //
//  Tool resolution
// --------------------------------------------------------------------------- //
// shutil.which() equivalent: search PATH, honoring PATHEXT on Windows.
//
// On Windows this MUST try `name + <PATHEXT ext>` and NOT the bare name — a
// bare `claude`/`npm` on PATH is usually an extensionless *nix shell shim that
// Windows CreateProcess cannot launch (ENOENT). shutil.which skips it for the
// runnable `.cmd`/`.exe`; we mirror that so npm/claude/gitleaks resolve correctly.
function globalBin(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  if (!IS_WIN) {
    // On POSIX, mirror shutil.which: the candidate must be a regular file AND
    // executable (X_OK). Skipping the X_OK check would "find" a non-executable
    // name-match and then fail to spawn (EACCES) instead of cleanly skipping.
    const isExec = (p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return isFile(p);
      } catch {
        return false;
      }
    };
    for (const dir of dirs) {
      const cand = path.join(dir, name);
      if (isExec(cand)) return cand;
    }
    return null;
  }

  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  // If the name already carries a known executable extension, use it as-is;
  // otherwise probe each PATHEXT extension (never the bare name).
  const hasExt = pathext.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const names = hasExt ? [name] : pathext.map((ext) => name + ext);
  for (const dir of dirs) {
    for (const n of names) {
      const cand = path.join(dir, n);
      if (isFile(cand)) return cand;
    }
  }
  return null;
}

function localBin(target, name) {
  // Resolve a JS tool from the project's own node_modules/.bin.
  const d = path.join(target, "node_modules", ".bin");
  const cands = IS_WIN ? [name + ".cmd", name] : [name];
  for (const c of cands) {
    const p = path.join(d, c);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
//  Built-in Supabase security check (pure-JS, read-only, no external tool)
//
//  Generic linters know nothing about Supabase, so this fills the gap with the
//  concrete "always/never" anti-patterns a live-DB audit would catch — adapted
//  to what is visible in code + SQL migrations. It reads files only; it never
//  connects to a database and never writes anything. Judgment calls (RLS
//  coverage, IDOR, RPC logic) are left to the AI reviewer in prompts/supabase.md.
// --------------------------------------------------------------------------- //
const SUPA_CODE_EXT = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte", ".astro", ".py"];
const SUPA_SQL_EXT = [".sql"];
const SUPA_MAX_FILE_BYTES = 2000000;

// Bundler prefixes that ship an env var to the browser. A service/secret key
// behind one of these is a critical leak of full database access.
const PUBLIC_ENV_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "REACT_APP_", "EXPO_PUBLIC_", "PUBLIC_", "GATSBY_"];

// Secrets / key exposure (any text)
const RE_SB_SECRET = /sb_secret_[A-Za-z0-9]{8,}/;
const RE_PUBLIC_SERVICE = new RegExp(
  "(?:" + PUBLIC_ENV_PREFIXES.join("|") + ")[A-Z0-9_]*(?:SERVICE_ROLE|SERVICE_KEY)");
const RE_SERVICE_ROLE = /service[_-]?role/i;
const RE_JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/;

// SQL migration anti-patterns
const RE_DISABLE_RLS = /disable\s+row\s+level\s+security/i;
const RE_ENABLE_RLS_TABLE = /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?["']?([A-Za-z0-9_.]+)["']?\s+enable\s+row\s+level\s+security/gi;
const RE_CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?["']?([A-Za-z0-9_.]+)/gi;
const RE_GRANT_ANON = /grant\s+(.+?)\s+on\s+(.+?)\s+to\s+([^;]*\b(?:anon|public)\b)/i;
const RE_CREATE_POLICY = /create\s+policy\b/i;
const RE_GRANT_WRITE = /\b(insert|update|delete|all|truncate|references|trigger)\b/i;
const RE_USE_CLIENT = /^\s*['"]use client['"]/m;

// Severity ordering for output.
const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function supaRead(p) {
  try {
    if (fs.statSync(p).size > SUPA_MAX_FILE_BYTES) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function looksLikeSupabase(target, texts) {
  // Cheap heuristic: does this project use Supabase at all?
  try {
    if (fs.statSync(path.join(target, "supabase")).isDirectory()) return true;
  } catch {
    /* no supabase dir */
  }
  const pkg = path.join(target, "package.json");
  try {
    if (fs.statSync(pkg).isFile()) {
      const t = supaRead(pkg);
      if (t && t.includes("@supabase/")) return true;
    }
  } catch {
    /* no package.json */
  }
  for (const content of Object.values(texts)) {
    const low = content.toLowerCase();
    if (low.includes("supabase") || low.includes("createclient(")) return true;
  }
  return false;
}

function scanSupabase(target, files, scopeAll) {
  // Return [status, text, command]. Read-only regex scan for Supabase risks.
  const candidates = scopeAll ? walkFiles(target) : [...files];

  const relevant = (rel) => {
    const low = rel.toLowerCase();
    const base = path.basename(low);
    return (
      endsWithExt(low, SUPA_CODE_EXT) ||
      endsWithExt(low, SUPA_SQL_EXT) ||
      base.startsWith(".env") ||
      base === "config.toml"
    );
  };

  const texts = {};
  for (const rel of candidates) {
    if (!relevant(rel)) continue;
    const ap = path.join(target, rel);
    try {
      if (!fs.statSync(ap).isFile()) continue;
    } catch {
      continue;
    }
    const c = supaRead(ap);
    if (c !== null) texts[rel] = c;
  }

  if (!looksLikeSupabase(target, texts)) {
    return ["SKIP", "no Supabase usage detected in scope", null];
  }

  const seen = new Set();
  const findings = []; // [severity, rel, lineNo, message]

  const add = (sev, rel, lineNo, msg) => {
    const key = `${rel} ${lineNo} ${msg}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push([sev, rel, lineNo, msg]);
    }
  };

  for (const [rel, content] of Object.entries(texts)) {
    const isSql = endsWithExt(rel, SUPA_SQL_EXT);
    const lines = content.split(/\r?\n/);
    // Next.js "use client" directive marks a browser bundle.
    const clientExposed = RE_USE_CLIENT.test(content.slice(0, 400));
    const hasPolicy = isSql ? RE_CREATE_POLICY.test(content) : false;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const i = idx + 1;

      // --- secret / key exposure (all file types) ---
      if (RE_SB_SECRET.test(line)) {
        add("HIGH", rel, i,
          "Hardcoded Supabase secret API key (sb_secret_...). Move it to a " +
          "server-only env var; never commit it.");
      }
      if (RE_PUBLIC_SERVICE.test(line)) {
        add("HIGH", rel, i,
          "service_role key exposed through a browser-exposed env var " +
          "(NEXT_PUBLIC_/VITE_/REACT_APP_/...). This ships full DB access to the client.");
      }
      if (RE_JWT.test(line) && RE_SERVICE_ROLE.test(line)) {
        add("HIGH", rel, i,
          "Likely hardcoded service_role key (JWT). The service role bypasses RLS - " +
          "keep it server-side and out of source.");
      }
      if (clientExposed && !isSql && RE_SERVICE_ROLE.test(line)) {
        add("HIGH", rel, i,
          "service_role referenced in a client-side ('use client') file. " +
          "The service role must never reach the browser.");
      }

      // --- SQL migration anti-patterns ---
      if (isSql) {
        if (RE_DISABLE_RLS.test(line)) {
          add("HIGH", rel, i,
            "Row Level Security disabled. The table becomes fully readable/writable " +
            "with the public anon key.");
        }
        const gm = RE_GRANT_ANON.exec(line);
        if (gm) {
          const privs = gm[1].trim();
          const write = RE_GRANT_WRITE.test(privs);
          const sev = write ? "MEDIUM" : "LOW";
          add(sev, rel, i,
            `GRANT to '${gm[3].trim()}' (${privs}). Grants to anon/public expose ` +
            "data via the REST API; prefer RLS policies over broad grants.");
        }
        if (hasPolicy && RE_SERVICE_ROLE.test(line)) {
          add("MEDIUM", rel, i,
            "service_role referenced inside a policy. service_role already bypasses " +
            "RLS, so this policy is likely a misconfiguration.");
        }
      }
    }

    // create table without enabling RLS (file-level heuristic)
    if (isSql) {
      // Tables that get RLS enabled somewhere in this file (by short name).
      const rlsTables = new Set();
      for (const m of content.matchAll(RE_ENABLE_RLS_TABLE)) {
        rlsTables.add(m[1].split(".").pop().toLowerCase());
      }
      for (const m of content.matchAll(RE_CREATE_TABLE)) {
        const tbl = m[1];
        const short = tbl.split(".").pop().toLowerCase();
        const lineNo = content.slice(0, m.index).split("\n").length;
        if (!rlsTables.has(short)) {
          add("MEDIUM", rel, lineNo,
            `Table '${tbl}' created without enabling Row Level Security in this file. ` +
            "Add: alter table ... enable row level security; and define policies.");
        }
      }
    }
  }

  if (findings.length === 0) {
    return ["PASS", "No Supabase anti-patterns found in scope.", "built-in Supabase static analysis"];
  }

  findings.sort((a, b) => {
    const sa = SEV_ORDER[a[0]] ?? 9;
    const sb = SEV_ORDER[b[0]] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return a[2] - b[2];
  });

  const counts = {};
  for (const [sev] of findings) counts[sev] = (counts[sev] || 0) + 1;
  const summary = ["HIGH", "MEDIUM", "LOW"]
    .filter((s) => s in counts)
    .map((s) => `${counts[s]} ${s.toLowerCase()}`)
    .join(", ");

  const out = [`Found ${findings.length} Supabase issue(s): ${summary}.`, ""];
  for (const [sev, rel, lineNo, msg] of findings) {
    out.push(`[${sev}] ${rel}:${lineNo}`);
    out.push(`    ${msg}`);
  }
  return ["FINDINGS", out.join("\n"), "built-in Supabase static analysis"];
}

// --------------------------------------------------------------------------- //
//  Check specifications
//  level: "file" (runs on matching files) | "repo" (runs once if triggered)
//         | "builtin" (pure-JS check, no external tool)
//  Every argv is READ-ONLY. Do not ever add fix/write flags here.
// --------------------------------------------------------------------------- //
function buildSpecs() {
  return [
    // ---- Python ----
    {
      id: "ruff", title: "Ruff - lint", cat: "lint", lang: "python",
      level: "file", exts: PY_EXT,
      resolve: () => globalBin("ruff"),
      argv: (e, f) => [e, "check", "--no-fix", "--force-exclude", ...f],
    },
    {
      id: "ruff-format", title: "Ruff - format check", cat: "format", lang: "python",
      level: "file", exts: PY_EXT,
      resolve: () => globalBin("ruff"),
      argv: (e, f) => [e, "format", "--check", "--force-exclude", ...f],
    },
    {
      id: "mypy", title: "mypy - types", cat: "types", lang: "python",
      level: "file", exts: PY_EXT,
      resolve: () => globalBin("mypy"),
      argv: (e, f) => [e, "--no-error-summary", ...f],
    },
    {
      id: "bandit", title: "Bandit - security", cat: "security", lang: "python",
      level: "file", exts: PY_EXT,
      resolve: () => globalBin("bandit"),
      argv: (e, f) => [e, "-q", "-ll"].concat(
        f.length === 1 && f[0] === "." ? ["-r", "."] : [...f]),
    },
    {
      id: "pip-audit", title: "pip-audit - dependencies", cat: "deps", lang: "python",
      level: "repo", trigger: ["requirements*.txt", "pyproject.toml", "setup.py", "Pipfile"],
      resolve: () => globalBin("pip-audit"),
      argv: (e) => [e],
    },

    // ---- JavaScript / TypeScript ----
    {
      id: "eslint", title: "ESLint - lint", cat: "lint", lang: "js",
      level: "file", exts: JS_EXT,
      resolve: (t) => localBin(t, "eslint"),
      argv: (e, f) => [e, "--no-error-on-unmatched-pattern", ...f],
    },
    {
      id: "prettier", title: "Prettier - format check", cat: "format", lang: "js",
      level: "file", exts: PRETTIER_EXT,
      resolve: (t) => localBin(t, "prettier"),
      argv: (e, f) => [e, "--check", "--ignore-unknown", ...f],
    },
    {
      id: "tsc", title: "TypeScript - types", cat: "types", lang: "js",
      level: "repo", trigger: ["tsconfig.json"],
      resolve: (t) => localBin(t, "tsc"),
      argv: (e) => [e, "--noEmit", "--pretty", "false"],
    },
    {
      id: "npm-audit", title: "npm audit - dependencies", cat: "deps", lang: "js",
      level: "repo", trigger: ["package.json"],
      resolve: () => globalBin("npm"),
      argv: (e) => [e, "audit", "--audit-level=high"],
    },

    // ---- Cross-cutting ----
    {
      id: "gitleaks", title: "Gitleaks - secrets", cat: "security", lang: "any",
      level: "repo", trigger: ["*"],
      resolve: () => globalBin("gitleaks"),
      argv: (e) => [e, "detect", "--no-git", "--no-banner", "--redact", "--source", "."],
    },

    // ---- Supabase (built-in, no external tool required) ----
    {
      id: "supabase", title: "Supabase - security & RLS", cat: "security", lang: "any",
      level: "builtin", builtin: scanSupabase,
    },
  ];
}

// Convert a simple glob (top-level only, e.g. "requirements*.txt") to a RegExp.
function globToRegExp(pattern) {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

function repoTriggered(target, patterns) {
  let entries;
  try {
    entries = fs.readdirSync(target);
  } catch {
    entries = [];
  }
  for (const pat of patterns) {
    if (pat === "*") return true;
    if (!pat.includes("*") && !pat.includes("?")) {
      // Literal name: a plain existence check (matches pathlib .glob on a literal).
      if (fs.existsSync(path.join(target, pat))) return true;
    } else {
      const re = globToRegExp(pat);
      if (entries.some((name) => re.test(name))) return true;
    }
  }
  return false;
}

// --------------------------------------------------------------------------- //
//  Running the deterministic checks
// --------------------------------------------------------------------------- //
function statusFrom(rc) {
  if (rc === "missing") return "SKIP";
  if (rc === "timeout" || rc === "error") return "ERROR";
  if (rc === 0) return "PASS";
  return "FINDINGS";
}

function result(spec, status, note, output, argv, command) {
  return {
    id: spec.id, title: spec.title, category: spec.cat,
    status, note: note ?? null, output: output || "",
    command: command || (argv ? argv.join(" ") : null),
  };
}

function runChecks(target, files, scopeAll, disabled, timeoutMs) {
  const results = [];
  for (const spec of buildSpecs()) {
    if (disabled.has(spec.id)) {
      results.push(result(spec, "OFF", "disabled in config", null, null));
      continue;
    }

    // Built-in checks run in-process (no external tool to resolve).
    if (spec.level === "builtin") {
      const [status, text, cmd] = spec.builtin(target, files, scopeAll);
      const note = status === "SKIP" || status === "OFF" ? text : null;
      const output = status === "SKIP" || status === "OFF" ? null : text;
      results.push(result(spec, status, note, output, null, cmd));
      continue;
    }

    const exe = spec.resolve(target);
    if (!exe) {
      const where = spec.lang === "js" && spec.level === "file"
        ? "in node_modules" : "on PATH";
      results.push(result(spec, "SKIP", `tool not available ${where}`, null, null));
      continue;
    }

    // Determine the argument set for this check.
    let argv;
    if (spec.level === "repo") {
      if (!repoTriggered(target, spec.trigger || ["*"])) {
        results.push(result(spec, "SKIP", "not applicable to this project", null, null));
        continue;
      }
      argv = spec.argv(exe, ["."]);
    } else {
      // file-level
      if (scopeAll) {
        argv = spec.argv(exe, ["."]);
      } else {
        const subset = files.filter((f) => endsWithExt(f, spec.exts));
        if (subset.length === 0) {
          results.push(result(spec, "SKIP", "no matching files in scope", null, null));
          continue;
        }
        argv = spec.argv(exe, subset);
      }
    }

    const [rc, out] = run(argv, target, timeoutMs);
    results.push(result(spec, statusFrom(rc), null, out, argv));
  }
  return results;
}

// --------------------------------------------------------------------------- //
//  AI review (optional, read-only, isolated)
// --------------------------------------------------------------------------- //
function collectDiff(target, base, staged, maxChars = 60000) {
  let diff;
  if (staged) {
    diff = git(["diff", "--cached"], target);
  } else {
    diff = "";
    if (base) diff = git(["diff", `${base}...HEAD`], target);
    const working = git(["diff", "HEAD"], target);
    if (working) diff = diff ? diff + "\n" + working : working;
  }
  diff = diff.trim();
  if (diff.length > maxChars) {
    diff = diff.slice(0, maxChars) + "\n\n[... diff truncated for review ...]";
  }
  return diff;
}

function aiReview(scannerDir, target, diff, runAll, timeoutMs) {
  const claude = globalBin("claude");
  if (!claude) {
    return [{ prompt: "review", status: "SKIP",
      output: "Claude CLI not found on PATH — AI review skipped." }];
  }
  if (!diff) {
    return [{ prompt: "review", status: "SKIP",
      output: "No diff in scope — nothing for AI to review." }];
  }

  const promptDir = path.join(scannerDir, ".quality", "prompts");
  let names = ["review"];
  if (runAll) {
    names = ["review", "security", "architecture", "performance", "business-logic", "supabase"];
  }

  const reviews = [];
  // Run Claude in a throwaway directory so it has NOTHING in the target to touch.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qg-"));
  try {
    for (const name of names) {
      const pf = path.join(promptDir, `${name}.md`);
      let instructions;
      try {
        if (!fs.statSync(pf).isFile()) continue;
        instructions = fs.readFileSync(pf, "utf8");
      } catch {
        continue;
      }
      const full =
        instructions +
        "\n\n---\nYou are operating in READ-ONLY review mode. Do not attempt " +
        "to modify, create, or run anything — only report findings.\n\n" +
        "Here is the unified diff to review:\n\n```diff\n" +
        diff + "\n```\n";
      const [rc, out] = run([claude, "-p"], tmp, timeoutMs, full);
      reviews.push({
        prompt: name,
        status: rc === 0 ? "PASS" : "ERROR",
        output: out || "(no output)",
      });
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }

  if (reviews.length === 0) {
    reviews.push({ prompt: "review", status: "SKIP",
      output: `No prompt files found in ${promptDir}.` });
  }
  return reviews;
}

// --------------------------------------------------------------------------- //
//  Reporting
// --------------------------------------------------------------------------- //
const STATUS_ICON = {
  PASS: "PASS", FINDINGS: "FIND", SKIP: "skip",
  ERROR: "ERR ", OFF: "off ",
};

function statusColor(status) {
  return ({
    PASS: C.ok, FINDINGS: C.bad, ERROR: C.warn,
    SKIP: C.dim, OFF: C.dim,
  })[status] || "";
}

function printConsole(meta, checks, reviews) {
  const P = (s) => process.stdout.write(s + "\n");
  P("");
  P(`${C.bold}${C.cyan}MarketInk Quality Gate${C.end}  ${C.dim}(read-only scanner)${C.end}`);
  P(`${C.dim}target : ${meta.target}${C.end}`);
  P(`${C.dim}scope  : ${meta.scope}  - files in scope: ${meta.file_count}${C.end}`);
  P(`${C.dim}time   : ${meta.time}${C.end}`);
  P("-".repeat(60));

  for (const r of checks) {
    const color = statusColor(r.status);
    const label = STATUS_ICON[r.status] || r.status;
    let line = `  ${color}[${label}]${C.end}  ${r.title}`;
    if (r.note) line += `  ${C.dim}- ${r.note}${C.end}`;
    P(line);
  }

  if (reviews.length) {
    P("");
    P(`  ${C.cyan}AI review${C.end}`);
    for (const rv of reviews) {
      const color = rv.status === "PASS" ? C.ok : rv.status === "ERROR" ? C.warn : C.dim;
      P(`  ${color}[${rv.status.toLowerCase().padEnd(4)}]${C.end}  claude -${rv.prompt}`);
    }
  }

  P("-".repeat(60));
  const findings = checks.filter((r) => r.status === "FINDINGS");
  const errors = checks.filter((r) => r.status === "ERROR");
  const passed = checks.filter((r) => r.status === "PASS");
  P(`  ${C.ok}${passed.length} passed${C.end}  - ` +
    `${C.bad}${findings.length} with findings${C.end}  - ` +
    `${C.warn}${errors.length} errors${C.end}  - ` +
    `${C.dim}${checks.length - passed.length - findings.length - errors.length} skipped${C.end}`);
  if (meta.report_path) {
    P(`  ${C.dim}full report: ${meta.report_path}${C.end}`);
  }
  P(`  ${C.dim}This scanner made no changes to your code.${C.end}`);
  P("");
}

function buildMarkdown(meta, checks, reviews) {
  const lines = [];
  lines.push("# Quality Gate Report");
  lines.push("");
  lines.push(`- **Target:** \`${meta.target}\``);
  lines.push(`- **Scope:** ${meta.scope} (${meta.file_count} files)`);
  lines.push(`- **Generated:** ${meta.time}`);
  lines.push(`- **Mode:** read-only scan — no files were modified`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Check | Category | Status | Note |");
  lines.push("|---|---|---|---|");
  for (const r of checks) {
    lines.push(`| ${r.title} | ${r.category} | ${r.status} | ${r.note || ""} |`);
  }
  lines.push("");

  const detail = checks.filter((r) => r.status === "FINDINGS" || r.status === "ERROR");
  if (detail.length) {
    lines.push("## Details");
    lines.push("");
    for (const r of detail) {
      lines.push(`### ${r.title} — ${r.status}`);
      if (r.command) lines.push(`\`${r.command}\``);
      lines.push("");
      let body = r.output || "(no output)";
      body = body.split(/\r?\n/).slice(0, 500).join("\n");
      lines.push("```");
      lines.push(body);
      lines.push("```");
      lines.push("");
    }
  }

  if (reviews.length) {
    lines.push("## AI Review");
    lines.push("");
    for (const rv of reviews) {
      lines.push(`### Claude - ${rv.prompt} - ${rv.status}`);
      lines.push("");
      lines.push(rv.output);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------- //
//  Timestamp helpers (local time, mirroring datetime.strftime)
// --------------------------------------------------------------------------- //
function pad2(n) {
  return String(n).padStart(2, "0");
}

function stampHuman(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function stampFile(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

// --------------------------------------------------------------------------- //
//  Main
// --------------------------------------------------------------------------- //
const HELP = `usage: node scan.js [options]

Read-only quality scanner. Never modifies your code.

  --path PATH     repo to scan (default: current dir)
  --all           scan the whole project, not just changes
  --staged        scan only git-staged changes
  --base REF      git base ref for the diff (default: auto)
  --no-ai         skip the AI review
  --ai-full       run all specialized AI reviewers
  --no-report     print only; write no files
  --out DIR       report output dir (default: ./quality-reports)
  --strict        exit 1 if findings (for optional CI)
  --timeout SEC   per-tool timeout in seconds (default: 600)
  -h, --help      show this help and exit
`;

function main(argv) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h", default: false },
        path: { type: "string", default: "." },
        all: { type: "boolean", default: false },
        staged: { type: "boolean", default: false },
        base: { type: "string" },
        "no-ai": { type: "boolean", default: false },
        "ai-full": { type: "boolean", default: false },
        "no-report": { type: "boolean", default: false },
        out: { type: "string" },
        strict: { type: "boolean", default: false },
        timeout: { type: "string", default: "600" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const timeoutSec = parseInt(args.timeout, 10);
  const timeoutMs = (Number.isFinite(timeoutSec) ? timeoutSec : 600) * 1000;

  const target = path.resolve(args.path);
  const scannerDir = __dirname;
  try {
    if (!fs.statSync(target).isDirectory()) throw new Error("not a dir");
  } catch {
    process.stderr.write(`error: path not found: ${target}\n`);
    return 2;
  }

  // Optional config (fully optional; safe defaults if absent).
  let disabled = new Set();
  let baseArg = args.base ?? null;
  const cfgPath = path.join(scannerDir, "quality-gate.config.json");
  try {
    if (fs.statSync(cfgPath).isFile()) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      disabled = new Set(cfg.disabled_checks || []);
      if (baseArg === null) baseArg = cfg.base_ref ?? null;
    }
  } catch {
    // a broken config must never break the scan
  }

  const gitOk = isGitRepo(target);
  const scopeAll = args.all || !gitOk;
  if (!gitOk && !args.all) {
    process.stdout.write(`${C.warn}note: not a git repository - scanning the whole project.${C.end}\n`);
  }

  const base = gitOk && !args.all ? resolveBase(target, baseArg) : null;

  let files;
  let scopeDesc;
  if (scopeAll) {
    files = walkFiles(target);
    scopeDesc = "whole project";
  } else {
    files = changedFiles(target, base, args.staged);
    scopeDesc = args.staged ? "staged changes" : `changed vs ${base || "working tree"}`;
  }

  const checks = runChecks(target, files, scopeAll, disabled, timeoutMs);

  let reviews = [];
  if (!args["no-ai"]) {
    if (scopeAll) {
      reviews = [{ prompt: "review", status: "SKIP",
        output: "AI review is diff-based; use a scoped scan (not --all) for AI." }];
    } else {
      const diff = collectDiff(target, base, args.staged);
      reviews = aiReview(scannerDir, target, diff, args["ai-full"], timeoutMs);
    }
  }

  const now = new Date();
  const meta = {
    target,
    scope: scopeDesc,
    file_count: files.length,
    time: stampHuman(now),
    report_path: null,
  };

  // Write report (the only thing this tool ever writes).
  if (!args["no-report"]) {
    const outDir = args.out ? path.resolve(args.out) : path.join(process.cwd(), "quality-reports");
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = stampFile(now);
      const md = buildMarkdown(meta, checks, reviews);
      fs.writeFileSync(path.join(outDir, `report-${stamp}.md`), md, "utf8");
      fs.writeFileSync(path.join(outDir, "latest.md"), md, "utf8");
      fs.writeFileSync(
        path.join(outDir, "latest.json"),
        JSON.stringify({ meta, checks, reviews }, null, 2),
        "utf8");
      meta.report_path = path.join(outDir, "latest.md");
    } catch (exc) {
      process.stdout.write(`${C.warn}note: could not write report (${exc.message}); printing only.${C.end}\n`);
    }
  }

  printConsole(meta, checks, reviews);

  if (args.strict && checks.some((r) => r.status === "FINDINGS")) {
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
