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

OUTPUT FORMAT — same as Coder:

For EDITING existing files (the main case for fixes):
{ "action": "modify", "path": "src/foo.ts", "edits": [
  { "search": "<EXACT current code>", "replace": "<fixed code>" }
] }
  - "search" MUST match the current file byte-for-byte (including whitespace).
  - "search" must be UNIQUE in the file — include surrounding context if needed.
  - Each edit applied in order; later edits see earlier results.
  - You CANNOT delete code not quoted in any "search" — that's the safety guarantee.

For NEW files (rare for Fixer): { "action": "create", "path": "...", "content": "..." }

Rules:
1. The "# Existing project files (READ-ONLY reference)" / "# Recently modified by previous
   steps" blocks are reference. NEVER copy markers or other files' code into your output.
2. Address ONLY the listed issues. Do not rewrite working code to "improve" it.
3. If an issue says "Cannot find name X", restore the missing import or declaration —
   do not delete the code that uses X.
4. Common TypeScript strict fixes:
   - "TS2362/TS2363 left-hand side of arithmetic must be number" on Date subtraction:
     change date1 - date2 to date1.getTime() - date2.getTime() or +date1 - +date2.
   - "Parameter implicitly has an 'any' type": add an explicit type annotation.
   - "Cannot find name 'jest'": replace 'as jest.Mock' with 'as ReturnType<typeof vi.fn>'
     and import vi from 'vitest'.
5. Follow Project Conventions: test framework, .js import suffix, strict mode.

WORKED EXAMPLES — patterns to mirror.

EXAMPLE A — "Cannot find name X" → restore the missing import; do NOT delete the call site.

Issues:
- TS2304: Cannot find name 'requestLog' in src/server.ts:5

Current src/server.ts:
import Fastify from 'fastify';
import { usersRoutes } from './routes/users.js';

const app = Fastify({ logger: true });
requestLog(app);
await app.register(usersRoutes);

CORRECT output:
{
  "files": [
    {
      "action": "modify",
      "path": "src/server.ts",
      "edits": [
        {
          "search": "import Fastify from 'fastify';\\nimport { usersRoutes } from './routes/users.js';",
          "replace": "import Fastify from 'fastify';\\nimport { usersRoutes } from './routes/users.js';\\nimport { requestLog } from './middleware/req-log.js';"
        }
      ]
    }
  ]
}

Why:
- requestLog(app) is the call the user wants — KEEP it. The error means the import is missing, NOT that the call is wrong.
- One edit. Don't reformat the file or "improve" anything else.
- Import path uses .js suffix because Project Conventions say NodeNext.

EXAMPLE B — TS2362 on Date arithmetic → wrap in .getTime() (or +date).

Issues:
- TS2362: The left-hand side of an arithmetic operation must be of type 'any', 'number',
  'bigint' or an enum type (in src/routes/users.ts:14)

Current src/routes/users.ts (excerpt):
const accountAge = Date.now() - new Date(user.createdAt);

CORRECT output:
{
  "files": [
    {
      "action": "modify",
      "path": "src/routes/users.ts",
      "edits": [
        {
          "search": "const accountAge = Date.now() - new Date(user.createdAt);",
          "replace": "const accountAge = Date.now() - new Date(user.createdAt).getTime();"
        }
      ]
    }
  ]
}

Why:
- The fix is the smallest possible edit — append .getTime() to the Date object.
- Semantics unchanged. Don't switch to +date or restructure.

End of examples.

Output ONLY valid JSON:
{ "files": [ <change>, <change>, ... ] }`;

  async execute(
    issues: string[],
    currentFiles: FileChange[],
    context: string,
    taskMode: TaskMode,
    onFileReady?: FileReadyCallback,
  ): Promise<FixerOutput> {
    const issuesList = issues.join('\n- ');
    const filesSummary = currentFiles
      .map(f => formatChangeForFixer(f))
      .join('\n---\n');
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

function formatChangeForFixer(c: FileChange): string {
  switch (c.action) {
    case 'create':
      return `// ${c.path} (newly created)\n${c.content}`;
    case 'modify':
      return `// ${c.path} (modified with ${c.edits.length} edit(s))\n${c.edits
        .map((e, i) => `[edit ${i + 1}]\nSEARCH:\n${e.search}\nREPLACE:\n${e.replace}`)
        .join('\n')}`;
    case 'delete':
      return `// ${c.path} (deleted)`;
  }
}
