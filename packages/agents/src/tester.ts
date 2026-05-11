import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';

// Tester only ever produces brand-new test files — never edits existing source.
// Restricting the schema to `action: 'create'` keeps the shape simple for the
// model and rejects accidental modify/delete responses up front.
const TesterTestFileSchema = z.object({
  action: z.literal('create'),
  path: z.string().min(1),
  content: z.string(),
});

export const TesterOutputSchema = z.object({
  testFiles: z.array(TesterTestFileSchema),
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
2. Use the test framework listed under "# Project Conventions". If it says vitest:
   - Import helpers: import { describe, it, expect, beforeEach, vi } from 'vitest';
   - NEVER use jest globals. The type "jest.Mock" DOES NOT EXIST in vitest — using it
     causes a TypeScript error.
   - To mock a function, use vi.fn(): const mockGet = vi.fn(); UserService.get = mockGet;
     mockGet.mockReturnValue(value);
   - To spy on an existing method: const spy = vi.spyOn(UserService, 'get');
     spy.mockReturnValue(value); afterEach(() => spy.mockRestore());
   - Cast a real method to a mock with the vi.MockedFunction type, never jest.Mock:
     (UserService.get as ReturnType<typeof vi.fn>).mockReturnValue(value);
3. Follow the import-path suffix convention. If "Import paths MUST include .js suffix"
   appears, ALL relative imports MUST end in .js — never .ts. For example:
   import { healthRoute } from '../routes/health.js' (NOT '../routes/health.ts').
4. Each test file MUST include action: "create" in its JSON entry — schema requires it.
5. Test OBSERVABLE BEHAVIOR. For HTTP handlers, use the real framework's inject helpers
   (e.g. app.inject({ method, url })) and assert on response status/body.
   Do NOT assert that app.get / app.register were called — those tests are meaningless.
   For Fastify tests specifically:
   - CORRECT: import Fastify, { FastifyInstance } from 'fastify'; let app: FastifyInstance; app = Fastify();
   - WRONG: let app: ReturnType<typeof Fastify>; — TS1361 error, do not use this pattern.
6. Do not mock the code under test. Mock only external side effects (network, disk).
7. Import from the correct relative paths seen in the reference. Use exact file names —
   e.g. '../services/user-service.js', not 'userService' or 'user-service'.
8. If a test asserts on a response body that the real handler builds dynamically
   (e.g. { id: randomUUID(), createdAt: new Date().toISOString() }), use partial matching
   like expect.objectContaining({ name: 'Jane' }) — don't assert exact equality.
9. CRITICAL: Every test file in testFiles MUST contain at least one it() or test() call.
   A describe block with only beforeEach and no it() tests is NOT acceptable — it causes
   vitest to fail with "No test found in suite". If you cannot write meaningful tests for
   a given file, omit it from testFiles entirely rather than producing an empty describe.

Output ONLY valid JSON:
{ "testFiles": [{ "path": "src/__tests__/foo.test.ts", "content": "...", "action": "create" }] }`;

  async execute(files: FileChange[], context: string, taskMode: TaskMode): Promise<TesterOutput> {
    const filesSummary = files.map(formatChangeForTester).join('\n---\n');
    const prompt = `Files changed:\n${filesSummary}\n\nContext:\n${context}\n\nGenerate unit tests JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, TesterOutputSchema);
  }
}

function formatChangeForTester(c: FileChange): string {
  switch (c.action) {
    case 'create':
      return `${c.action}: ${c.path}\n${c.content}`;
    case 'modify':
      return `${c.action}: ${c.path}\n${c.edits
        .map((e, i) => `[edit ${i + 1}] SEARCH:\n${e.search}\nREPLACE:\n${e.replace}`)
        .join('\n')}`;
    case 'delete':
      return `${c.action}: ${c.path}`;
  }
}
