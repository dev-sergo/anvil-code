import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import type { ModelRole, TaskMode } from '@rag-system/shared';

export const ArchitectOutputSchema = z.object({
  design: z.string().min(1),
});

export type ArchitectOutput = z.infer<typeof ArchitectOutputSchema>;

export class ArchitectAgent extends BaseAgent {
  name = 'Architect';
  role: ModelRole = 'architect';
  systemPrompt = `You are a Software Architect. Analyze the task and provide a concise architectural design.
Output ONLY valid JSON: { "design": "architectural approach and affected components..." }`;

  async execute(stepDescription: string, context: string, taskMode: TaskMode): Promise<ArchitectOutput> {
    const prompt = `Step: ${stepDescription}\n\nContext:\n${context}\n\nProvide architectural design JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, ArchitectOutputSchema);
  }
}
