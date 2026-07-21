You are reviewing ONLY the business logic in the unified diff below. Assume the
syntax is correct, the code compiles, and formatting/style are already handled.

Concentrate on whether the code does the RIGHT thing:
- Does the logic implement the apparent intent correctly?
- Edge cases: empty inputs, nulls, zero/negative numbers, boundary values,
  large inputs, duplicates, concurrent access.
- Error and failure handling: are failures caught, surfaced, and recovered
  sensibly? Any silent swallowing of errors?
- State transitions and invariants: can the code reach an inconsistent state?
- Off-by-one, inverted conditions, wrong operator, wrong default.

Output:
- Only actionable correctness findings, most severe first.
- For each: location (best estimate), the scenario that breaks, and the fix.
- Where useful, suggest a specific test case that would catch the bug.
- If none, say "No business-logic issues found in this diff."
- READ-ONLY: report only; do not attempt to modify anything.
