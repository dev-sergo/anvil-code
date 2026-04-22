import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';
import { FileChangeSchema } from './coder.js';

export const TesterOutputSchema = z.object({
  testFiles: z.array(FileChangeSchema),
});

export type TesterOutput = z.infer<typeof TesterOutputSchema>;

export class TesterAgent extends BaseAgent {
  name = 'Tester';
  role: ModelRole = 'tester';
  systemPrompt = `You are a QA Engineer. Given code changes, generate unit tests.
Output ONLY valid JSON: { "testFiles": [{ "path": "src/__tests__/foo.test.ts", "content": "...", "action": "create" }] }`;

  async execute(files: FileChange[], context: string, taskMode: TaskMode): Promise<TesterOutput> {
    const filesSummary = files.map(f => `${f.action}: ${f.path}\n${f.content}`).join('\n---\n');
    const prompt = `Files changed:\n${filesSummary}\n\nContext:\n${context}\n\nGenerate unit tests JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, TesterOutputSchema);
  }
}
