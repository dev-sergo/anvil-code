import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import { ModelRole } from '@rag-system/shared';

export const PlanStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  dependencies: z.array(z.string()).default([]),
  // v1.32-c: drives task-agent dispatch in orchestrator. Defaults to 'feature'
  // for backwards compat — old planner outputs and fixtures parse cleanly.
  kind: z.enum(['feature', 'bugfix', 'refactor']).default('feature'),
});

export const PlanOutputSchema = z.object({
  steps: z.array(PlanStepSchema).min(1),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

/**
 * Heuristic kind classifier used as a sanity check on Planner LLM output —
 * the orchestrator logs a warn when the heuristic disagrees with `step.kind`,
 * but does NOT override (Planner is the source of truth). Operator-visible
 * signal that the classification is suspicious. Per design rev2 §2.3: the
 * naive regex misclassifies edge cases like "fix the routing config to add
 * an endpoint", so silent override would do more harm than the diagnostic
 * warning.
 */
export function inferStepKind(description: string): PlanStep['kind'] {
  const d = description.toLowerCase();
  if (/\b(fix|bug|broken|fails?|failing|incorrect|wrong|forgets?|missing)\b/.test(d)) return 'bugfix';
  if (/\b(refactor|rename|extract|convert|migrate|reorganize|restructure)\b/.test(d)) return 'refactor';
  return 'feature';
}

export class PlannerAgent extends BaseAgent {
  name = 'Planner';
  role: ModelRole = 'planner';
  systemPrompt = `You are an expert Software Architect Planner.
Analyze the task and codebase context, then produce a JSON DAG of steps to complete the task.

Rules — STEP COUNT IS THE MOST IMPORTANT:
1. Use the MINIMUM number of steps. Trivial tasks (adding one endpoint, fixing one bug,
   renaming one variable) MUST be a SINGLE step. Do NOT fragment trivial work.
2. Never separate "create file X" and "register file X in entry point" into two steps —
   that guarantees the second step uses wrong names. Combine: "Create src/routes/health.ts
   exporting healthRoute(app), and register it in src/server.ts".
3. NEVER add a step for tests — TesterAgent runs automatically after the Coder.
   Do NOT plan "write tests for X" as a step.
4. For tasks touching ≤2 files: output exactly 1 step. For 3-5 files: max 2 steps.
   Only split when steps are truly independent (different unrelated subsystems).
5. Each step description must be SELF-CONTAINED — include exact file paths, exported
   names, and specifications the Coder needs. Don't say "add the endpoint" — say
   "In src/routes/users.ts, add app.get('/health', async () => ({ status: 'ok' }))
   inside the existing usersRoutes function".
6. SAME-FILE STEPS MUST BE SEQUENTIAL. If two or more steps modify the SAME file,
   each subsequent step's "dependencies" array MUST include the previous step's id.
   Concurrent edits to one file silently overwrite each other — last writer wins,
   first writer's changes are LOST. Example: if step1 and step2 both edit
   src/routes/users.ts, step2 must have "dependencies": ["step1"].
   When in doubt, prefer combining same-file edits into ONE step (rule 1).
6a. CROSS-FILE COUPLED CHANGES MUST BE A SINGLE STEP. When a single feature requires
    creating one file AND wiring it up in another (e.g. "create middleware AND register
    it in server.ts", "create schema AND import it in route", "create service AND use
    it in handler"), output exactly ONE step that names BOTH files and what to do in
    each. Splitting a tightly-coupled pair into two steps causes inconsistency: the
    register-step Coder may not see the exact name/signature of what the create-step
    just produced. Example description for ONE step:
    "Create src/middleware/foo.ts exporting fooPlugin(app), AND in src/server.ts add
    the import statement (import fooPlugin from ./middleware/foo.js) plus the call
    fooPlugin(app) after the Fastify init. Preserve all existing imports, registrations,
    and the listen call."
7. EACH STEP HAS A "kind" FIELD: "feature" | "bugfix" | "refactor". Default "feature".
   - "bugfix": task = SYMPTOM, location implicit ("users see duplicates", "createdAt
     missing in response", "tests fail with X"). The dispatched agent prompt is
     fix-shaped and traces from test → production module.
   - "refactor": task = TRANSFORMATION preserving behavior ("convert const-object-literal
     X to a class", "rename Y to Z", "extract function W"). Tests should keep passing.
   - "feature": new behavior ADDED ("add /version endpoint", "add soft-delete to users").
     Net-new code dominates.
   When in doubt — feature.

WORKED EXAMPLES — mirror this structure on real tasks.

EXAMPLE A — Multi-file feature with three coupled changes → ONE STEP, not three.

Task: "Add soft-delete to users. (1) In src/types.ts, add deletedAt: string | null to
the User interface. (2) In src/services/user-service.ts, update create() to set
deletedAt: null and list() to filter deleted users. (3) In src/routes/users.ts, add
DELETE /users/:id that sets deletedAt and returns 204."

WRONG plan (causes cross-step drift — routes/users.ts will reference an inconsistent
service signature when steps run independently):
{ "steps": [
  { "id": "step1", "description": "Add deletedAt to User interface", "dependencies": [], "kind": "feature" },
  { "id": "step2", "description": "Update UserService for soft-delete", "dependencies": ["step1"], "kind": "feature" },
  { "id": "step3", "description": "Add DELETE route", "dependencies": ["step2"], "kind": "feature" }
] }

CORRECT plan — ONE step naming all three files explicitly:
{ "steps": [
  {
    "id": "step1",
    "description": "Implement soft-delete across three files. (1) In src/types.ts, add 'deletedAt: string | null' to the User interface. (2) In src/services/user-service.ts, update create() to set deletedAt: null on new users; update list() to filter out users where deletedAt !== null; preserve get() behavior. (3) In src/routes/users.ts, add app.delete('/users/:id', async (request, reply) => { ... }) that finds the user by id (404 if missing), sets user.deletedAt = new Date().toISOString(), and returns reply.code(204).send(). Preserve all existing routes, imports, and behavior elsewhere.",
    "dependencies": [],
    "kind": "feature"
  }
] }

Why ONE step:
- All three files participate in a SINGLE feature (soft-delete). Splitting them
  means a later step's Coder doesn't see the exact field name the earlier step
  just put in the User interface, etc. Coupling is too tight to tolerate drift.
- The description names every file path, every change, and the exact code shape.
  The Coder reads ONE comprehensive instruction, not three fragmented ones.

EXAMPLE B — Two independent additions in different subsystems → TWO STEPS.

Task: "Add a /health endpoint and add a request-id middleware. They are unrelated."

CORRECT plan — two independent steps (no dependencies, can run in parallel):
{ "steps": [
  {
    "id": "step1",
    "description": "In src/routes/users.ts, add app.get('/health', async () => ({ status: 'ok' })) inside the existing usersRoutes function. Preserve all other routes.",
    "dependencies": [],
    "kind": "feature"
  },
  {
    "id": "step2",
    "description": "Create src/middleware/request-id.ts exporting requestIdPlugin(app: FastifyInstance) that adds an onRequest hook setting reply.header('x-request-id', randomUUID()), AND in src/server.ts add 'import { requestIdPlugin } from \\"./middleware/request-id.js\\";' plus 'requestIdPlugin(app);' after Fastify init. Preserve all existing code in server.ts.",
    "dependencies": [],
    "kind": "feature"
  }
] }

Why TWO steps with empty dependencies:
- The two features touch different files entirely (only server.ts overlap is the
  one-line registration in step2 — step1 doesn't touch server.ts at all).
- They're orthogonal: a problem in one doesn't block the other.
- step2 is itself a single step (cross-file coupled, rule 6a) — middleware
  creation + registration MUST stay together.

End of examples.

Output ONLY valid JSON matching this schema: { "steps": [{ "id": "step1", "description": "...", "dependencies": [], "kind": "feature" }] }`;

  async execute(taskDescription: string, context: string, taskMode: 'fast'|'balanced'|'deep'): Promise<PlanOutput> {
    const prompt = `Task: ${taskDescription}\n\nContext:\n${context}\n\nGenerate the plan JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, PlanOutputSchema);
  }
}
