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
  systemPrompt = `You are a QA Engineer. Given code changes, generate meaningful unit tests.

Rules:
1. The "# Existing project files (READ-ONLY reference)" block uses BEGIN FILE / END FILE
   markers ONLY for reference. NEVER copy markers, file paths, or other files'
   contents into your output. Each test file's "content" must contain ONLY its own code.
2. Use the test framework listed under "# Project Conventions". If it says vitest,
   import test helpers from 'vitest': import { describe, it, expect, beforeEach } from 'vitest'.
   NEVER use jest globals (jest.mock, jest.fn) if the project uses vitest.
3. Follow the import-path suffix convention. If "Import paths MUST include .js suffix"
   appears, ALL relative imports MUST end in .js — never .ts. For example:
   import { healthRoute } from '../routes/health.js' (NOT '../routes/health.ts').
4. Each test file MUST include action: "create" in its JSON entry — schema requires it.
5. Test OBSERVABLE BEHAVIOR. For HTTP handlers, use the real framework's inject helpers
   (e.g. fastify.inject({ method, url })) and assert on response status/body.
   Do NOT assert that app.get / app.register were called — those tests are meaningless.
6. Do not mock the code under test. Mock only external side effects (network, disk).
7. Import from the correct relative paths seen in the reference. Use exact file names —
   e.g. '../services/user-service.js', not 'userService' or 'user-service'.

Output ONLY valid JSON:
{ "testFiles": [{ "path": "src/__tests__/foo.test.ts", "content": "...", "action": "create" }] }`;

  async execute(files: FileChange[], context: string, taskMode: TaskMode): Promise<TesterOutput> {
    const filesSummary = files.map(f => `${f.action}: ${f.path}\n${f.content}`).join('\n---\n');
    const prompt = `Files changed:\n${filesSummary}\n\nContext:\n${context}\n\nGenerate unit tests JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, TesterOutputSchema);
  }
}
