import fs from 'fs';
import path from 'path';
import type { ProjectConventions } from './project-conventions.js';

export interface PromptContextInput {
  conventions: ProjectConventions;
  ragSnippets: string;
  ragFilePaths: string[];
  projectRoot: string;
  designContext?: string;
}

const MAX_BYTES_PER_FILE = 8 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;

/**
 * Build a structured context block for code-generating agents (Coder, Fixer, Tester).
 * Order matters: Project Conventions first (model reads top-down), then full source
 * files of the files likely to change, then RAG snippets for wider context, then
 * optional design notes from Architect.
 */
export function buildPromptContext(input: PromptContextInput): string {
  const fullSources = readFullSources(input.ragFilePaths, input.projectRoot);
  const sections: string[] = [];

  sections.push(`# Project Conventions\n${input.conventions.summary}`);

  if (fullSources) {
    sections.push(
      `# Existing project files (READ-ONLY reference)\n` +
      `These are the CURRENT contents of files that may need modifying. They are reference material — do NOT replicate this structure or these markers in your output. Each output file you generate must contain ONLY its own code.\n\n` +
      fullSources
    );
  }

  if (input.ragSnippets.trim()) {
    sections.push(`# Related code snippets (READ-ONLY, for broader context)\n${input.ragSnippets}`);
  }

  if (input.designContext?.trim()) {
    sections.push(`# Architectural design\n${input.designContext}`);
  }

  return sections.join('\n\n');
}

function readFullSources(filePaths: string[], projectRoot: string): string {
  const unique = Array.from(new Set(filePaths));
  const parts: string[] = [];
  let total = 0;

  for (const filePath of unique) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    if (content.length > MAX_BYTES_PER_FILE) {
      content = content.slice(0, MAX_BYTES_PER_FILE) + `\n// ... (truncated, original was ${content.length} bytes)`;
    }

    const relPath = path.relative(projectRoot, abs);
    // Use explicit BEGIN/END FILE markers (uppercase, unmistakable) instead of
    // // comments or ## headers. The model can't accidentally copy these into
    // generated code: they're not valid TypeScript syntax.
    const block = `===== BEGIN FILE: ${relPath} =====\n${content}\n===== END FILE: ${relPath} =====`;

    if (total + block.length > MAX_TOTAL_BYTES) break;
    parts.push(block);
    total += block.length;
  }

  return parts.join('\n\n');
}
