import fs from 'fs';
import path from 'path';
import type { ProjectConventions } from './project-conventions.js';
import { config } from './config.js';
import { logger } from './logger.js';

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
  /**
   * v1.64 — Validation errors that were auto-fixed by the Fixer in previous
   * tasks on this project. Injected before conventions so Planner and Coder
   * see repo-specific constraints (e.g. import path patterns) proactively.
   */
  repoPatterns?: string[];
  /**
   * v1.71 — override the whole-block byte budget (see config.rag.
   * maxPromptContextBytes). Mainly for tests; production callers rely on the
   * config default.
   */
  maxContextBytes?: number;
}

const MAX_BYTES_PER_FILE = 3 * 1024;  // 3KB per file (~700 tokens) — was 8KB; large repos fill 32k ctx
const MAX_TOTAL_BYTES = 10 * 1024;   // 10KB total (~2500 tokens) — was 32KB; real repos overflow 32k ctx

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

  // Sections carry a `prune` rank: 0 = essential (never dropped), higher =
  // dropped first when the assembled block exceeds the byte budget (v1.71).
  // RAG snippets are broadest/lowest-value, so they go first; the repo-map is
  // next (it's an inventory the agent can partly reconstruct from sources).
  // Everything load-bearing for correctness — conventions, files-to-edit,
  // recently-modified state, the design, and learned patterns — is kept.
  const sections: Array<{ text: string; prune: number }> = [];

  if (input.repoPatterns && input.repoPatterns.length > 0) {
    const list = input.repoPatterns.map(p => `- ${p}`).join('\n');
    sections.push({ prune: 0, text:
      `# Repo-specific patterns (learned from previous tasks)\n` +
      `These validation errors were previously encountered and auto-fixed. ` +
      `Apply them proactively to avoid repeating the same mistakes:\n\n` +
      list
    });
  }

  sections.push({ prune: 0, text: `# Project Conventions\n${input.conventions.summary}` });

  if (input.repoMap && input.repoMap.trim()) {
    sections.push({ prune: 2, text:
      `# Repo Map (high-level structure of THIS project)\n` +
      `Authoritative inventory of files and exported symbols available to reference. ` +
      `Do NOT invent methods, classes, or files that are not listed here. ` +
      `If you need behavior that isn't present, modify an existing file or create a new one — ` +
      `but every symbol you reference must either appear below, be a standard-library/framework name, ` +
      `or be one you are creating in this same step.\n\n` +
      input.repoMap
    });
  }

  if (input.newlySources && input.newlySources.length > 0) {
    const block = input.newlySources
      .map(({ path, content }) => `===== BEGIN MODIFIED: ${path} =====\n${content}\n===== END MODIFIED: ${path} =====`)
      .join('\n\n');
    sections.push({ prune: 0, text:
      `# Recently modified by previous steps (CURRENT state — SUPERSEDES "Existing project files")\n` +
      `These files were just edited by earlier steps in THIS task. Their content here is the LATEST version. When modifying any of these files, base your output on THIS content, not on the older disk version. Preserve everything not directly affected by your current step.\n\n` +
      block
    });
  }

  if (fullSources) {
    sections.push({ prune: 0, text:
      `# Existing project files (READ-ONLY reference)\n` +
      `These are the CURRENT contents of files that may need modifying. They are reference material — do NOT replicate this structure or these markers in your output. Each output file you generate must contain ONLY its own code.\n\n` +
      fullSources
    });
  }

  if (input.ragSnippets.trim()) {
    sections.push({ prune: 3, text: `# Related code snippets (READ-ONLY, for broader context)\n${input.ragSnippets}` });
  }

  if (input.designContext?.trim()) {
    sections.push({ prune: 0, text: `# Architectural design\n${input.designContext}` });
  }

  return enforceBudget(sections, input.maxContextBytes ?? config.rag.maxPromptContextBytes);
}

/**
 * v1.71 — keep the assembled context under a byte budget. Drops the highest
 * `prune` rank first (RAG snippets, then repo-map); essential sections (rank 0)
 * are never dropped even if that means exceeding the budget — sending a slightly
 * oversized prompt of load-bearing content beats sending one with the
 * files-to-edit pruned away. Logs whenever it drops anything (never silent).
 */
function enforceBudget(sections: Array<{ text: string; prune: number }>, maxBytes: number): string {
  const SEP = '\n\n';
  const totalBytes = (xs: Array<{ text: string }>) =>
    xs.reduce((n, s) => n + Buffer.byteLength(s.text), 0) + Math.max(0, xs.length - 1) * SEP.length;

  let kept = sections;
  let total = totalBytes(kept);
  if (total <= maxBytes) return kept.map(s => s.text).join(SEP);

  const dropped: number[] = [];
  // Prune ranks strictly descending so we always shed the lowest-value content
  // first, and only as much as needed to fit.
  const ranks = [...new Set(sections.map(s => s.prune).filter(r => r > 0))].sort((a, b) => b - a);
  for (const rank of ranks) {
    if (total <= maxBytes) break;
    const before = total;
    kept = kept.filter(s => s.prune !== rank);
    total = totalBytes(kept);
    dropped.push(rank);
    logger.warn(
      { rank, freedBytes: before - total, totalBytes: total, maxBytes },
      'Prompt context over budget — pruned section to avoid model context overflow',
    );
  }
  if (total > maxBytes) {
    logger.warn(
      { totalBytes: total, maxBytes },
      'Prompt context still over budget after pruning all non-essential sections — sending essential content as-is',
    );
  }
  return kept.map(s => s.text).join(SEP);
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
