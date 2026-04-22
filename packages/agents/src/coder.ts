import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import { ModelRole } from '@rag-system/shared';

export const FileChangeSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  action: z.enum(['create', 'modify', 'delete']),
});

export const CoderOutputSchema = z.object({
  files: z.array(FileChangeSchema),
});

export type CoderOutput = z.infer<typeof CoderOutputSchema>;

export class CoderAgent extends BaseAgent {
  name = 'Coder';
  role: ModelRole = 'coder';
  systemPrompt = `You are an expert Software Engineer.
Given a plan step and codebase context, generate the necessary file changes.
Output ONLY valid JSON matching this schema:
{ "files": [{ "path": "src/file.ts", "content": "file contents here", "action": "create|modify|delete" }] }`;

  async execute(stepDescription: string, context: string, taskMode: 'fast'|'balanced'|'deep'): Promise<CoderOutput> {
    const prompt = `Step: ${stepDescription}\n\nContext:\n${context}\n\nGenerate the code changes JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, CoderOutputSchema);
  }
}
