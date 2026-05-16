import { z } from 'zod';
import { BaseAgent } from './base-agent.js';
import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';

export const ReviewerOutputSchema = z.object({
  isApproved: z.boolean(),
  issues: z.array(z.string()),
});

export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

export class ReviewerAgent extends BaseAgent {
  name = 'Reviewer';
  role: ModelRole = 'reviewer';
  systemPrompt = `You are a Code Reviewer. Approve or reject code changes based on BLOCKING issues only.

CRITICAL: Base your review SOLELY on the files and step description provided below. Do NOT apply
requirements, types, or conventions from other projects, codebases, or frameworks you may have
seen before. Each review is independent — ignore any prior context.

APPROVE (isApproved: true) when the code:
- Correctly implements what the step description asks for
- Does not introduce obvious runtime bugs (null dereference, wrong condition, broken logic)
- Does not remove or break existing functionality

REJECT (isApproved: false) ONLY for BLOCKING problems:
- The code does NOT implement the requested feature (wrong path, wrong return value, missing key logic)
- There is an obvious runtime bug that will cause errors at runtime
- Existing working code is deleted or broken

DO NOT reject for:
- Code style or formatting preferences
- Architecture or design pattern choices
- TypeScript type annotations (checked separately by the build)
- Missing edge case handling unless explicitly required by the task
- Incomplete changes across files — other steps may cover the rest
- Handler/callback parameter names or signatures — a compact handler with no named params is valid if behavior is correct
- Exact wording of error messages, log strings, or comments (only reject if the logic producing them is wrong)

Keep issues to 1-3 items max. Only list blocking problems.
Output ONLY valid JSON: { "isApproved": true|false, "issues": ["blocking issue"] }`;

  async execute(stepDescription: string, files: FileChange[], context: string, taskMode: TaskMode): Promise<ReviewerOutput> {
    const filesSummary = files.map(formatChangeForReview).join('\n---\n');
    const filePaths = files.map(f => f.path).slice(0, 5).join(', ');
    const anchor = `[Reviewing changes in: ${filePaths}${files.length > 5 ? ` and ${files.length - 5} more` : ''}]`;
    const prompt = `${anchor}\nStep: ${stepDescription}\n\nFiles:\n${filesSummary}\n\nContext:\n${context}\n\nProvide review JSON.`;
    const response = await this.callLLM(prompt, taskMode, true);
    return this.parseAndValidate(response, ReviewerOutputSchema);
  }
}

function formatChangeForReview(c: FileChange): string {
  switch (c.action) {
    case 'create':
      return `// ${c.path} (new file)\n${c.content}`;
    case 'modify':
      return `// ${c.path} (${c.edits.length} edit block(s))\n${c.edits
        .map((e, i) => `[edit ${i + 1}]\n--- SEARCH ---\n${e.search}\n--- REPLACE ---\n${e.replace}`)
        .join('\n')}`;
    case 'delete':
      return `// ${c.path} (deleted)`;
  }
}
