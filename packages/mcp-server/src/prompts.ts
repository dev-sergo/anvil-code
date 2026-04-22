export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description: string;
  messages: PromptMessage[];
  // MCP SDK GetPromptResult is z.core.$loose — allow extra fields
  [k: string]: unknown;
}

function userMsg(text: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text } };
}

export function buildAddFeaturePrompt(args: { feature: string; area?: string }): PromptResult {
  const area = args.area?.trim();
  const lines = [
    `I want to add the following feature: **${args.feature}**`,
    '',
    'Please follow this workflow:',
    '',
    `1. Use \`search_code\` to find the relevant code${area ? ` (start with: "${area}")` : ''}.`,
    '2. Read \`adr://recent\` to check for past decisions that constrain the design.',
    '3. Read \`failures://top\` to avoid known pitfalls.',
    '4. Submit the task via \`run_task\` (mode: balanced) once you have enough context.',
    '5. Poll \`get_task_status\` until the task completes; report the result.',
  ];
  return {
    description: `Add feature: ${args.feature.slice(0, 80)}`,
    messages: [userMsg(lines.join('\n'))],
  };
}

export function buildFixBugPrompt(args: { description: string; file?: string }): PromptResult {
  const file = args.file?.trim();
  const lines = [
    `There is a bug to fix: **${args.description}**`,
    '',
    'Please follow this workflow:',
    '',
    `1. Use \`search_code\` to locate the failing area${file ? ` — start with the file: \`${file}\`` : ''}.`,
    '2. Use \`get_related_code\` on the suspect symbol to understand callers and dependencies.',
    '3. Read \`failures://top\` — this bug may match a known pattern.',
    '4. Submit a fix via \`run_task\` (mode: balanced); the orchestrator will plan, code, test, and review.',
    '5. Poll \`get_task_status\`; if the result mentions partial completion, surface that to the user.',
  ];
  return {
    description: `Fix bug: ${args.description.slice(0, 80)}`,
    messages: [userMsg(lines.join('\n'))],
  };
}

export function buildRefactorPrompt(args: { target: string; goal?: string }): PromptResult {
  const goal = args.goal?.trim();
  const lines = [
    `I want to refactor: **${args.target}**`,
    goal ? `Goal: ${goal}` : 'Goal: improve clarity, reduce duplication, preserve behavior.',
    '',
    'Workflow:',
    '',
    `1. \`search_code\` for "${args.target}" to map the affected surface area.`,
    '2. For each top symbol, call \`get_related_code\` to identify all callers.',
    '3. Read \`adr://recent\` — refactors must respect prior architectural decisions.',
    '4. Submit via \`run_task\` (mode: deep) so the larger model can reason about cross-file changes.',
    '5. Confirm tests still pass via \`get_task_status\` (the validation loop runs typecheck+tests automatically).',
  ];
  return {
    description: `Refactor: ${args.target.slice(0, 80)}`,
    messages: [userMsg(lines.join('\n'))],
  };
}

export function buildAddTestsPrompt(args: { target: string }): PromptResult {
  const lines = [
    `Add tests for: **${args.target}**`,
    '',
    'Workflow:',
    '',
    `1. \`search_code\` for "${args.target}" to find the symbol(s) under test.`,
    '2. \`get_related_code\` to find dependencies that may need mocks.',
    '3. Submit via \`run_task\` with a description like "Add tests for ${args.target}, covering happy path and edge cases".',
    '4. The TesterAgent will write tests and the validation loop will run them — check \`get_task_status\` for the verdict.',
  ];
  return {
    description: `Add tests for: ${args.target.slice(0, 80)}`,
    messages: [userMsg(lines.join('\n'))],
  };
}
