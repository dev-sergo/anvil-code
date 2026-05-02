import type { PlanStep } from '../planner.js';
import { FEATURE_SPEC } from './feature.js';
import { BUGFIX_SPEC } from './bugfix.js';
import { REFACTOR_SPEC } from './refactor.js';
import type { TaskAgentSpec } from './spec.js';

export const SPECS: Record<PlanStep['kind'], TaskAgentSpec> = {
  feature: FEATURE_SPEC,
  bugfix: BUGFIX_SPEC,
  refactor: REFACTOR_SPEC,
};

/** Pick the spec for a plan step's kind; defaults to feature when undefined. */
export function pickSpec(kind: PlanStep['kind'] | undefined): TaskAgentSpec {
  return SPECS[kind ?? 'feature'];
}
