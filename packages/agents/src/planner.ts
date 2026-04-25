import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import { ModelRole } from '@rag-system/shared';

export const PlanStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  dependencies: z.array(z.string()).default([]),
});

export const PlanOutputSchema = z.object({
  steps: z.array(PlanStepSchema).min(1),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

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

Output ONLY valid JSON matching this schema: { "steps": [{ "id": "step1", "description": "...", "dependencies": [] }] }`;

  async execute(taskDescription: string, context: string, taskMode: 'fast'|'balanced'|'deep'): Promise<PlanOutput> {
    const prompt = `Task: ${taskDescription}\n\nContext:\n${context}\n\nGenerate the plan JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, PlanOutputSchema);
  }
}
