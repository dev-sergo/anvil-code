import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import { ModelRole } from '@rag-system/shared';
import { streamFileChanges, type PartialFile } from './partial-json.js';

export const FileChangeSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  action: z.enum(['create', 'modify', 'delete']),
});

export const CoderOutputSchema = z.object({
  files: z.array(FileChangeSchema),
});

export type CoderOutput = z.infer<typeof CoderOutputSchema>;
export type FileReadyCallback = (file: PartialFile, index: number) => void;

export class CoderAgent extends BaseAgent {
  name = 'Coder';
  role: ModelRole = 'coder';
  systemPrompt = `You are an expert Software Engineer.
Given a plan step and codebase context, generate the necessary file changes.

Rules you MUST follow:
1. The "# Existing project files (READ-ONLY reference)" block uses BEGIN FILE / END FILE
   markers ONLY to delimit reference material. NEVER copy these markers, file paths,
   or other files' contents into your output. Each file in your output JSON's "content"
   field must contain ONLY that file's own code — nothing else.
2. When action is "modify", preserve EVERY existing import, type, and export from the
   reference file. Change ONLY what the step requires. Never strip unrelated code.
3. Follow the "# Project Conventions" block strictly:
   - Use the specified test framework (e.g. vitest), never jest if vitest is listed.
   - If "Import paths MUST include .js suffix" appears, ALL relative imports MUST end
     in .js, even when the source file is .ts. Example: import { x } from './foo.js'.
   - Match TypeScript strict mode (no implicit any, explicit types on parameters).
4. Prefer MODIFYING existing files over creating parallel alternatives. If an entry
   point (server.ts / main.ts / app.ts / index.ts) is listed under conventions,
   modify it. Do not create a parallel bootstrap.
5. Make MINIMAL changes. Do not add unrelated refactoring, comments, console.log, or
   code unrelated to the step.
6. Do NOT write test files in this output — a separate Tester agent handles tests.
7. Preserve the trailing newline of existing files. Use \\n at end of content.

Output ONLY valid JSON matching this schema:
{ "files": [{ "path": "src/file.ts", "content": "file contents here", "action": "create|modify|delete" }] }`;

  async execute(
    stepDescription: string,
    context: string,
    taskMode: 'fast'|'balanced'|'deep',
    onFileReady?: FileReadyCallback,
  ): Promise<CoderOutput> {
    const prompt = `Step: ${stepDescription}\n\nContext:\n${context}\n\nGenerate the code changes JSON.`;

    // Two paths share the same underlying stream: incremental file extraction
    // (for early callbacks/SSE) and full-text accumulation (for tolerant Zod
    // validation at the end). The accumulated text remains the source of truth
    // since the partial parser intentionally tolerates malformed entries.
    let full = '';
    let index = 0;
    const tee = teeStream(this.streamLLM(prompt, taskMode, true), c => { full += c; });

    if (onFileReady) {
      for await (const file of streamFileChanges(tee)) {
        onFileReady(file, index++);
      }
    } else {
      // Drain without callback so we still pull every chunk.
      for await (const _ of tee) { /* no-op */ }
    }

    return this.parseAndValidate(full, CoderOutputSchema);
  }
}

/** Yields every chunk while also calling `tap` synchronously per chunk. */
async function *teeStream(
  source: AsyncIterable<string>,
  tap: (chunk: string) => void,
): AsyncIterable<string> {
  for await (const chunk of source) {
    tap(chunk);
    yield chunk;
  }
}
