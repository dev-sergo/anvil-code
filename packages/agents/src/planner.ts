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
Output ONLY valid JSON matching this schema: { "steps": [{ "id": "step1", "description": "...", "dependencies": [] }] }`;

  async execute(taskDescription: string, context: string, taskMode: 'fast'|'balanced'|'deep'): Promise<PlanOutput> {
    const prompt = `Task: ${taskDescription}\n\nContext:\n${context}\n\nGenerate the plan JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, PlanOutputSchema);
  }
}
