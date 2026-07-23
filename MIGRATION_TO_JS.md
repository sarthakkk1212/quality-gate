# Migration Plan — `scan.py` → `scan.js` (single Node file)

> **Goal:** replace the one Python file (`scan.py`) with one Node file (`scan.js`)
> that behaves identically, has **zero npm dependencies** (Node built-ins only),
> and installs with nothing beyond Node — which every machine and CI runner in an
> all-JS/TS org already has.
>
> **Not a rewrite of the design.** Same two layers (deterministic tools + AI
> review), same read-only guarantee, same report format. Only the wrapper language
> and how it's launched change.

---

## 0. The one idea that must not be lost

**The language the tool is *written in* has nothing to do with the languages it
*scans*.**

`scan.py` scans JS/TS projects today by shelling out to `eslint`/`tsc`/`npm audit`.
`scan.js` will scan **Python** projects the exact same way — by shelling out to
`ruff`/`mypy`/`bandit`/`pip-audit`. It's an **orchestrator**: it runs other tools
and collects their output.

➡️ **Therefore: keep every check spec, including the Python ones.** Do not delete
the Python checks just because the tool is now in Node. That is what makes it work
for *both* stacks — today (JS/TS) and later (Python), as requested.

The only thing that changes for a user: they need **Node installed** instead of
**Python installed**. In your org, Node is already everywhere; Python was the
odd one out. That's the whole win.

---

## 1. Principles (keep it simple — no over-engineering)

- **One file.** `scan.js`, top to bottom, same section layout as `scan.py`.
- **Zero dependencies.** Only Node built-ins (`child_process`, `fs`, `path`, `os`,
  `util`, `process`). No `package.json` needed to *run* it — `node scan.js` just works.
- **Read-only, always.** No `--fix`/`--write` flags. Only output is the report file.
- **Behavior parity first.** Same flags, same statuses, same report. Improvements
  come *after* parity, not during.

**Prerequisite:** Node 18+ (for `util.parseArgs`). Recommend Node 20+.

---

## 2. Direct construct mapping (Python → Node)

Everything in `scan.py` has a one-to-one Node built-in equivalent. No library needed.

| `scan.py` uses | `scan.js` uses | Notes |
|---|---|---|
| `subprocess.run(..., capture_output, text, timeout, input)` | `child_process.spawnSync(cmd, args, {cwd, input, timeout, encoding:'utf8', maxBuffer})` | **timeout is milliseconds** in Node → multiply the `--timeout` seconds by 1000 |
| return code / `FileNotFoundError` / `TimeoutExpired` | `result.status`, `result.error.code === 'ENOENT'`, `result.signal === 'SIGTERM'` | map to the same `'missing'`/`'timeout'`/`'error'` strings |
| combine `stdout` + `stderr` | `(result.stdout || '') + (result.stderr || '')` | same trim logic |
| `shutil.which(name)` | small `which(name)` helper (scan `process.env.PATH` split on `path.delimiter`) | on Windows also try `name.cmd` / `name.exe` |
| `node_modules/.bin/<tool>` resolution | same path check | try `<tool>.cmd` then `<tool>` on Windows |
| `os.walk` + `IGNORE_DIRS` | recursive `fs.readdirSync(dir, {withFileTypes:true})` | skip the same `IGNORE_DIRS` set |
| `pathlib.Path(...).glob(pattern)` (repo triggers) | `fs.existsSync` / a tiny glob over `fs.readdirSync` | triggers are simple (`package.json`, `tsconfig.json`, `requirements*.txt`, `*`) |
| `re.compile(r"...", re.I)` (Supabase check) | `new RegExp("...", "i")` | regex syntax is compatible; port almost line-for-line |
| `tempfile.TemporaryDirectory()` (AI review sandbox) | `fs.mkdtempSync(path.join(os.tmpdir(),'qg-'))` + `try/finally` `fs.rmSync(dir,{recursive:true,force:true})` | keep the "run Claude in a throwaway dir" isolation |
| `argparse` | `util.parseArgs({ options, allowPositionals:false })` | same flag names |
| `json.loads` / `json.dumps` | `JSON.parse` / `JSON.stringify(obj, null, 2)` | report JSON identical |
| `datetime.now().strftime(...)` | `new Date()` + small format helper | timestamp for `report-YYYYMMDD-HHMMSS.md` |
| ANSI color class `C` | same ANSI constants; disable when `!process.stdout.isTTY` or `process.env.NO_COLOR` | identical behavior |
| `sys.exit(code)` | `process.exit(code)` | same exit codes: `0`, `1` (`--strict` + findings), `2` (bad `--path`) |

---

## 3. Target file layout (`scan.js`) — mirror `scan.py`

Keep the same top-to-bottom sections so anyone who knows `scan.py` can follow it:

1. Header comment (what it does / what it never does — copy the safety guarantees).
2. File-type groups (`PY_EXT`, `JS_EXT`, `PRETTIER_EXT`) + `IGNORE_DIRS`.
3. ANSI colors + TTY/`NO_COLOR` detection.
4. `run(argv, cwd, timeoutMs, input)` — the safe `spawnSync` wrapper (never throws).
5. Git helpers (`git`, `isGitRepo`, `resolveBase`, `changedFiles`, `walkFiles`).
6. Tool resolution (`globalBin` = `which`, `localBin` = node_modules/.bin).
7. **Built-in Supabase check** (`scanSupabase`) — port the regexes + logic verbatim.
8. `buildSpecs()` — **all** checks: `ruff`, `ruff-format`, `mypy`, `bandit`,
   `pip-audit`, `eslint`, `prettier`, `tsc`, `npm-audit`, `gitleaks`, `supabase`.
9. `runChecks(...)` — including the `level === 'builtin'` branch.
10. AI review (`collectDiff`, `aiReview`) — read prompts from `.quality/prompts/`.
11. Reporting (`printConsole`, `buildMarkdown`) — identical output.
12. `main()` — arg parsing, config load, scope resolution, write report, exit code.

> The `.quality/prompts/*.md`, `.quality/standards/CLAUDE.template.md`, and
> `quality-gate.config.json` files **do not change at all** — `scan.js` reads the
> same files `scan.py` did.

---

## 4. Step-by-step

1. **Add `scan.js`** next to `scan.py`. Port section by section using the table in §2.
   Do the deterministic engine first, then the Supabase check, then AI review, then
   reporting. Leave `scan.py` untouched during the port.
2. **Port the check specs 1:1.** Same `id`, `title`, `cat`, `lang`, `level`,
   triggers, and argv builders. **Keep the Python checks.** This is what preserves
   "scans PY and JS/TS alike."
3. **Port `scanSupabase` verbatim.** The regexes are compatible; just swap
   `re.compile(r"...", re.I)` → `new RegExp(String.raw`...`, "i")` and
   `content.splitlines()` → `content.split(/\r?\n/)`.
4. **Wire the built-in branch** in `runChecks` (the `level === 'builtin'` case that
   calls `scanSupabase` and returns `{status, text, command}`).
5. **AI review sandbox:** create a temp dir, pipe the prompt + diff to `claude -p`
   via `input`, clean up in `finally`.
6. **Reporting:** produce the same console table, `latest.md`, `report-<stamp>.md`,
   and `latest.json` (`{meta, checks, reviews}`) so existing dashboards/PR-comment
   steps keep working unchanged.
7. **Run both in parallel on the same repos** and diff the outputs until they match
   (see §6).
8. **Flip the switch** once parity is confirmed (see §7 rollout).

---

## 5. Platform gotchas (Windows-aware — your primary machine is Windows)

- **`.cmd` shims:** on Windows, npm-installed bins are `eslint.cmd`, `prettier.cmd`,
  `tsc.cmd`, and `npm` is `npm.cmd`. The `which`/`localBin` helpers must try the
  `.cmd` (and `.exe`) variants first, exactly like `scan.py` does today.
- **`spawnSync` + `.cmd`:** running a `.cmd` may need `{shell:false}` with the full
  path (preferred, safe) — resolve the absolute path via `which` and pass it as the
  command, matching how `scan.py` resolves `exe` before calling it. Avoid `shell:true`
  (quoting/injection risk and it breaks the read-only simplicity).
- **Timeout units:** Node `spawnSync` timeout is **ms**; `--timeout` is in seconds.
  Convert once (`timeoutSec * 1000`).
- **`maxBuffer`:** set it generously (e.g. 20 MB) so large tool output isn't truncated
  or turned into an error.
- **Encoding:** pass `encoding:'utf8'` to `spawnSync`; no `reconfigure` dance needed.

---

## 6. Parity test checklist (prove it before switching)

Reuse the synthetic-fixture approach already used for the Supabase check.

- [ ] **Non-git dir** → both fall back to whole-project scan with the same note.
- [ ] **JS/TS repo** → same checks run, same PASS/FINDINGS/SKIP per tool.
- [ ] **Python repo** → `ruff`/`mypy`/`bandit`/`pip-audit` still run and report
      identically (this is the "works for Python too" proof).
- [ ] **Supabase fixture** (the 9-issue one) → identical findings, severities, order.
- [ ] **Clean Supabase project** → `PASS`; **non-Supabase** → `SKIP`.
- [ ] **`--staged` / `--base` / `--all`** → same file scoping.
- [ ] **`--no-ai` / `--ai-full`** → same reviewer set (6 reviewers on full).
- [ ] **`--strict`** → exit `1` only when there are findings; `2` on bad `--path`.
- [ ] **Report files** → `latest.md`, `latest.json`, timestamped file all written;
      `latest.json` shape (`{meta, checks, reviews}`) byte-comparable modulo timestamps.

**Quick diff harness:** run `python scan.py ... --out A` and `node scan.js ... --out B`
on the same repo, then compare `A/latest.json` vs `B/latest.json` (ignoring the
`meta.time` field).

---

## 7. Rollout (low-risk, reversible)

1. **Coexist.** Ship `scan.js` alongside `scan.py`. Nothing breaks.
2. **Repoint the alias** once parity passes:
   ```powershell
   # was: function qg { python E:\...\scan.py @args }
   function qg { node E:\MarketInk\Quality_Gate\quality-gate\scan.js @args }
   ```
   ```bash
   qg() { node /path/to/quality-gate/scan.js "$@"; }
   ```
3. **Update CI** (`.github/workflows/quality-scan.yml`): drop the Python setup, use
   `actions/setup-node`, call `node scan.js ...`. (The clone-the-scanner-at-runtime
   step stays the same.)
4. **Update docs** — swap `python scan.py` → `node scan.js` in the Handbook, README,
   GUIDE, INTEGRATION. Note the new prerequisite (Node 18+ instead of Python 3.8+).
5. **Keep `scan.py` for one release** as a fallback, then remove it once the team is
   fully on `scan.js`.

---

## 8. Explicitly out of scope (avoid over-engineering)

Do **not** do these now — they add complexity without serving the goal:

- ❌ Publishing an npm package / `npx` distribution. (Nice later; not needed for a
  single file. `node scan.js` is enough.)
- ❌ TypeScript + a build step. (Plain `.js` keeps it a single runnable file with no
  compile. Add JSDoc types if you want editor hints — no build.)
- ❌ Adding dependencies (arg-parsers, glob libs, chalk). Built-ins cover all of it.
- ❌ Rewriting the checks or the report format. Parity only.

---

## 9. Acceptance criteria (done = all true)

- `node scan.js` runs on a machine with **no Python installed** and produces the
  same report `python scan.py` did.
- A **Python project** and a **JS/TS project** both scan correctly from the same
  `scan.js` — Python tools run when present, JS tools run when present.
- The Supabase built-in check and all 6 AI reviewers behave identically.
- Zero npm dependencies; one file; still 100% read-only.
- Docs, alias, and CI updated; `scan.py` kept temporarily as a fallback.

---

*Bottom line: this is a wrapper-language swap, not a redesign. Keep the Python check
specs so the tool serves both stacks, port construct-for-construct using §2, prove
parity with §6, and roll out reversibly with §7.*
