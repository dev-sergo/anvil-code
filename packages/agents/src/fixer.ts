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
  systemPrompt = `You are a Code Fixer. Fix the listed issues with minimal, surgical edits.

Rules:
1. The "# Existing project files (READ-ONLY reference)" block uses BEGIN FILE / END FILE
   markers ONLY to delimit reference material. NEVER copy these markers, file paths,
   or other files' contents into your output.
2. Preserve every import, type, and export not directly implicated by the issues.
3. Follow the "# Project Conventions" block strictly:
   - If "Import paths MUST include .js suffix" appears, ALL relative imports MUST
     end in .js, even when the source file is .ts.
   - Use the specified test framework (e.g. vitest), never jest if vitest is listed.
4. Address ONLY the listed issues. Do not rewrite working code to "improve" it.
5. If an issue says "Cannot find name X", restore the missing import or declaration
   rather than deleting the code that uses X.

Output ONLY valid JSON:
{ "files": [{ "path": "src/file.ts", "content": "...", "action": "modify" }] }`;

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
