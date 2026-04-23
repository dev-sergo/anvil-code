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
