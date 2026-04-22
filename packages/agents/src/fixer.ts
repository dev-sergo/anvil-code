import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';
import { FileChangeSchema } from './coder.js';

export const FixerOutputSchema = z.object({
  files: z.array(FileChangeSchema),
});

export type FixerOutput = z.infer<typeof FixerOutputSchema>;

export class FixerAgent extends BaseAgent {
  name = 'Fixer';
  role: ModelRole = 'fixer';
  systemPrompt = `You are a Code Fixer. Fix the code based on review issues.
Output ONLY valid JSON: { "files": [{ "path": "src/file.ts", "content": "...", "action": "modify" }] }`;

  async execute(issues: string[], currentFiles: FileChange[], context: string, taskMode: TaskMode): Promise<FixerOutput> {
    const issuesList = issues.join('\n- ');
    const filesSummary = currentFiles.map(f => `// ${f.path}\n${f.content}`).join('\n---\n');
    const prompt = `Issues to fix:\n- ${issuesList}\n\nCurrent files:\n${filesSummary}\n\nContext:\n${context}\n\nProvide fixed files JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, FixerOutputSchema);
  }
}
