# CLAUDE.md — <PROJECT NAME>

> Drop this file at the root of a project (rename to `CLAUDE.md`). Claude Code
> reads it automatically, and the Quality Gate's AI review uses it as the
> standard. Delete rules that don't apply; add project-specific ones. Keep every
> rule concrete and phrased as "always/never" so reviews stay objective.

## Project context
- **What this service does:** <one or two lines>
- **Stack:** <e.g. Python 3.12 / FastAPI, or Node 20 / TypeScript / React>
- **Entry points:** <where the app starts / key modules>

## Architecture rules
- Never access the database directly from controllers/handlers. Always go
  through the repository (or service) layer.
- Dependencies point inward: domain logic never imports web/framework code.
- One module, one responsibility. Split modules that grow past a clear purpose.
- Never duplicate business logic — extract and reuse.

## Naming & structure
- <naming convention, e.g. snake_case for Python, camelCase for TS>
- <folder layout expectations>

## API conventions
- Every endpoint validates its input before use.
- Errors return a consistent shape: `<describe>`.
- <versioning / pagination / auth header conventions>

## Security rules
- Never log secrets, tokens, credentials, or PII.
- Never build SQL/queries by string concatenation — use parameterized queries.
- All external input is untrusted until validated.
- <auth/authorization expectations>

## Testing expectations
- Every new feature ships with tests for its core paths and key edge cases.
- Cover error/failure behavior, not just the happy path.
- Coverage is a diagnostic, not a target — test the risky logic, don't chase %.

## PR expectations
- Keep PRs small and focused; one logical change per PR.
- Update docs/README when behavior or config changes.
- No commented-out code, no leftover debug logging.
