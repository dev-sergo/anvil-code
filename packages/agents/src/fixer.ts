import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';
import { FileChangeSchema, type FileReadyCallback } from './coder.js';
import { streamFileChanges } from './partial-json.js';

export const FixerOutputSchema = z.object({
  files: z.array(FileChangeSchema),
});

export type FixerOutput = z.infer<typeof FixerOutputSchema>;

export class FixerAgent extends BaseAgent {
  name = 'Fixer';
  role: ModelRole = 'fixer';
  systemPrompt = `You are a Code Fixer. Fix the code based on review issues.
Output ONLY valid JSON: { "files": [{ "path": "src/file.ts", "content": "...", "action": "modify" }] }`;

  async execute(
    issues: string[],
    currentFiles: FileChange[],
    context: string,
    taskMode: TaskMode,
    onFileReady?: FileReadyCallback,
  ): Promise<FixerOutput> {
    const issuesList = issues.join('\n- ');
    const filesSummary = currentFiles.map(f => `// ${f.path}\n${f.content}`).join('\n---\n');
    const prompt = `Issues to fix:\n- ${issuesList}\n\nCurrent files:\n${filesSummary}\n\nContext:\n${context}\n\nProvide fixed files JSON.`;

    let full = '';
    let index = 0;
    const tee = (async function *(this: FixerAgent) {
      for await (const chunk of this.streamLLM(prompt, taskMode, true)) {
        full += chunk;
        yield chunk;
      }
    }).call(this);

    if (onFileReady) {
      for await (const file of streamFileChanges(tee)) onFileReady(file, index++);
    } else {
      for await (const _ of tee) { /* drain */ }
    }

    return this.parseAndValidate(full, FixerOutputSchema);
  }
}
