/**
 * Specialization fragments injected into per-spec system prompts. v1.32-c
 * keeps the FEATURE / BUGFIX system prompts byte-identical to the previous
 * Coder / Fixer prompts so AC6 (L1.1 regression with FEATURE_SPEC) remains
 * meaningful as a control. Cross-spec deduplication into a SHARED_PROMPT_CORE
 * is deferred to v1.32-c.1 once bench evidence confirms dispatch behavior.
 */

/**
 * Prepended to the Coder system prompt for REFACTOR_SPEC. Surfaces the
 * structural-tools-may-not-fit fact at the top of the prompt where the model
 * reads it before tool selection. v1.31.2 L3.1 bench (object-literal → class
 * conversion) showed the model trying add_method first, getting "class X not
 * found" errors, then falling back to replace_in_file successfully — three
 * wasted calls. This preamble shortens the path.
 */
export const REFACTOR_PREAMBLE = `REFACTOR DEFAULT TOOL ORDERING:
Refactor tasks often modify existing code that does NOT match AST primitives (e.g. const-object-literal patterns, not FunctionDeclaration). Do NOT default to structural tools first — they will reject with "X not found".
Workflow: read_file → plan edits → replace_in_file for line-coord changes; structural tools (replace_method / replace_function) ONLY when the symbol clearly matches (a class method, a top-level function declaration).
Refactor preserves behavior. If a test fails after your edits — your refactor broke something, the test is not "outdated."

`;

/**
 * Appended to the Fixer system prompt for BUGFIX_SPEC. Closes the navigation
 * gap surfaced by L4.1 v1.32-a.x: when a test failure points at a test path,
 * the model needs an explicit instruction to open the production module the
 * test exercises (via the test's import statements) instead of editing the
 * test. v1.32-a addressed this through scope discipline (test paths
 * forbidden) but did not give the model a constructive workflow — only a no.
 */
export const BUGFIX_NAVIGATION_HINT = `

NAVIGATION FOR BUG FIXES:
- If the task describes a SYMPTOM, not a file (e.g. "users see duplicates"), start by reading entry points (server.ts, routes/, services/) and trace via read_file.
- A test failure means the bug is in the production module the test exercises. Read the test's imports, open the production file, fix it there.
- Do NOT edit tests to silence failing assertions. Test paths are forbidden from writes (read-grants-write does not bypass this) — the cheapest path to a green commit is also the wrong one.`;
