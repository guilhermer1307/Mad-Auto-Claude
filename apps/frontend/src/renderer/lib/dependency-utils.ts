/**
 * Task dependency utilities
 *
 * Functions for managing task execution dependencies:
 * - Circular dependency detection (DFS)
 * - Dependency satisfaction checks
 * - Queue filtering for blocked/unblocked tasks
 */

import type { Task } from '../../shared/types';

/**
 * Detect circular dependencies using DFS.
 * Returns true if adding `newDependencies` to a task would create a cycle.
 */
export function detectCircularDependency(
  newDependencies: string[],
  allTasks: Task[],
  newTaskSpecId?: string
): boolean {
  // Build adjacency map: specId -> dependsOn specIds
  const graph = new Map<string, string[]>();
  for (const task of allTasks) {
    const deps = task.metadata?.taskDependencies || [];
    graph.set(task.specId, deps);
  }

  // Add the new task's dependencies (if editing an existing task or creating a new one)
  if (newTaskSpecId) {
    graph.set(newTaskSpecId, newDependencies);
  }

  // DFS cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;

    visited.add(node);
    inStack.add(node);

    for (const dep of graph.get(node) || []) {
      if (hasCycle(dep)) return true;
    }

    inStack.delete(node);
    return false;
  }

  // For new tasks without a specId yet: check if any dependency transitively
  // depends on any other dependency (which would form a cycle through the new task)
  if (!newTaskSpecId) {
    // No specId yet, so no existing node references back to this task.
    // Just verify the existing graph plus new deps doesn't have cycles.
    for (const dep of newDependencies) {
      visited.clear();
      inStack.clear();
      if (hasCycle(dep)) return true;
    }
    return false;
  }

  // Check from the new task's node
  return hasCycle(newTaskSpecId);
}

/**
 * Check if all dependencies of a task are satisfied (in 'done' or 'pr_created' status).
 */
export function areDependenciesSatisfied(
  task: Task,
  allTasks: Task[]
): boolean {
  const deps = task.metadata?.taskDependencies;
  if (!deps || deps.length === 0) return true;

  const taskMap = new Map(allTasks.map(t => [t.specId, t]));
  return deps.every(depId => {
    const depTask = taskMap.get(depId);
    return depTask && (depTask.status === 'done' || depTask.status === 'pr_created');
  });
}

/**
 * Get the names of unsatisfied dependency tasks for display purposes.
 */
export function getUnsatisfiedDependencyNames(
  task: Task,
  allTasks: Task[]
): string[] {
  const deps = task.metadata?.taskDependencies;
  if (!deps || deps.length === 0) return [];

  const taskMap = new Map(allTasks.map(t => [t.specId, t]));
  return deps
    .filter(depId => {
      const depTask = taskMap.get(depId);
      return !depTask || (depTask.status !== 'done' && depTask.status !== 'pr_created');
    })
    .map(depId => {
      const depTask = taskMap.get(depId);
      return depTask ? depTask.title || depTask.specId : depId;
    });
}
