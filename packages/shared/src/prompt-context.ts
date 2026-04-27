import fs from 'fs';
import path from 'path';
import type { ProjectConventions } from './project-conventions.js';

export interface PromptContextInput {
  conventions: ProjectConventions;
  ragSnippets: string;
  ragFilePaths: string[];
  projectRoot: string;
  designContext?: string;
  /**
   * Files just edited by previous steps in the same task. They take precedence
   * over "Existing project files" — the disk hasn't been written yet, so the
   * latest content lives only here.
   */
  newlySources?: Array<{ path: string; content: string }>;
  /**
   * Compact "repo-map" of the whole project — file tree plus key signatures
   * from the AST (built via @rag-system/code-graph buildRepoMap). When set,
   * this is the second section of the prompt, right after Project Conventions.
   * Its purpose is to give the model an authoritative inventory of what exists,
   * so it doesn't hallucinate methods/files. Empty string is treated as absent.
   */
  repoMap?: string;
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
  // Avoid showing the same file twice (recent version wins) — if a file is in
  // newlySources, drop it from the disk-read list.
  const recentPaths = new Set((input.newlySources ?? []).map(s => s.path));
  const onDiskPaths = input.ragFilePaths.filter(p => !recentPaths.has(p));

  const fullSources = readFullSources(onDiskPaths, input.projectRoot);
  const sections: string[] = [];

  sections.push(`# Project Conventions\n${input.conventions.summary}`);

  if (input.repoMap && input.repoMap.trim()) {
    sections.push(
      `# Repo Map (high-level structure of THIS project)\n` +
      `Authoritative inventory of files and exported symbols available to reference. ` +
      `Do NOT invent methods, classes, or files that are not listed here. ` +
      `If you need behavior that isn't present, modify an existing file or create a new one — ` +
      `but every symbol you reference must either appear below, be a standard-library/framework name, ` +
      `or be one you are creating in this same step.\n\n` +
      input.repoMap
    );
  }

  if (input.newlySources && input.newlySources.length > 0) {
    const block = input.newlySources
      .map(({ path, content }) => `===== BEGIN MODIFIED: ${path} =====\n${content}\n===== END MODIFIED: ${path} =====`)
      .join('\n\n');
    sections.push(
      `# Recently modified by previous steps (CURRENT state — SUPERSEDES "Existing project files")\n` +
      `These files were just edited by earlier steps in THIS task. Their content here is the LATEST version. When modifying any of these files, base your output on THIS content, not on the older disk version. Preserve everything not directly affected by your current step.\n\n` +
      block
    );
  }

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
