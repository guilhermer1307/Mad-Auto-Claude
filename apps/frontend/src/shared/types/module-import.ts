/**
 * Module Import Types
 *
 * Types for importing external module specs (from skills projects)
 * into Auto Claude as executable tasks.
 */

export interface ModuleValidationPhase {
  phase: number;
  name: string;
  taskCount: number;
  dependsOn: number[];
}

export interface ModuleValidationResult {
  moduleName: string;
  taskCount: number;
  phases: ModuleValidationPhase[];
  hasReviewedToBe: boolean;
  hasAsIs: boolean;
  hasToBe: boolean;
  taskFiles: string[];
}

export interface ModuleImportResult {
  specId: string;
  specDir: string;
  taskCount: number;
  phaseCount: number;
}
