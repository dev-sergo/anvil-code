import { FEATURE_SPEC } from './feature.js';
import { REFACTOR_PREAMBLE } from './shared-prompts.js';
import type { TaskAgentSpec } from './spec.js';

/**
 * v1.32-c REFACTOR_SPEC — preserves-behavior transformations of existing
 * code (L3.1: const-object-literal → class). Same scope discipline + tool
 * primitives as FEATURE_SPEC, but the system prompt is prepended with a
 * REFACTOR_PREAMBLE that warns the model AST primitives may not match the
 * actual file shape (defaulting to structural-tool-first wastes calls).
 *
 * MAX_TOOL_CALLS = 40 — refactor frequently touches many places in one file
 * (vs FEATURE's typically additive single point). Slightly looser than the
 * Fixer's 30 (no validation-driven retry pressure) but tighter than the
 * additive Coder's 50.
 */
export const REFACTOR_SPEC: TaskAgentSpec = {
  ...FEATURE_SPEC,
  kind: 'refactor',
  agentName: 'Refactor(tool-calling)',
  systemPrompt: REFACTOR_PREAMBLE + FEATURE_SPEC.systemPrompt,
  maxToolCalls: 40,
};
