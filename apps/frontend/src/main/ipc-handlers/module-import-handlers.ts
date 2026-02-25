/**
 * Module Import IPC Handlers
 *
 * Handles validation and execution of external module imports.
 * The source module folder (from a skills project) can be on any path on disk,
 * while the import target is always the currently active Auto Claude project.
 *
 * NOTE: The import execution calls skills_importer.py directly (not run.py),
 * because skills_importer.py is stdlib-only and Python 3.9+ compatible,
 * while run.py enforces Python 3.10+ and requires a full venv with dependencies.
 */

import { ipcMain, app } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { IPC_CHANNELS, getSpecsDir } from '../../shared/constants';
import type { IPCResult, ModuleValidationResult, ModuleImportResult, TaskMetadata } from '../../shared/types';
import { projectStore } from '../project-store';
import { getAutoBuildSourcePath } from './context/utils';
import { findPythonCommand } from '../python-detector';

const execFileAsync = promisify(execFile);

/**
 * Phase layer ranges matching the Python backend (skills_importer.py LAYER_RANGES)
 */
const LAYER_RANGES: Array<{ min: number; max: number; phase: number; name: string }> = [
  { min: 1, max: 99, phase: 1, name: 'Domain Layer' },
  { min: 100, max: 199, phase: 2, name: 'Infrastructure Layer' },
  { min: 200, max: 299, phase: 3, name: 'Application Layer' },
  { min: 300, max: 399, phase: 4, name: 'Presentation Layer' },
  { min: 400, max: 499, phase: 5, name: 'Integration' },
  { min: 500, max: 599, phase: 6, name: 'Migration' },
  { min: 600, max: 699, phase: 7, name: 'Testing' },
];

function getPhaseForTask(taskNumber: number): { phase: number; name: string } | null {
  for (const range of LAYER_RANGES) {
    if (taskNumber >= range.min && taskNumber <= range.max) {
      return { phase: range.phase, name: range.name };
    }
  }
  return null;
}

/**
 * Register module import IPC handlers
 */
export function registerModuleImportHandlers(
  _pythonEnvManager: unknown,
  getMainWindow: () => BrowserWindow | null
): void {
  // Validate module folder structure (pure Node.js, no Python needed)
  ipcMain.handle(
    IPC_CHANNELS.MODULE_IMPORT_VALIDATE,
    async (_, modulePath: string): Promise<IPCResult<ModuleValidationResult>> => {
      try {
        if (!existsSync(modulePath)) {
          return { success: false, error: 'Directory does not exist' };
        }

        const hasReviewedToBe = existsSync(path.join(modulePath, 'reviewed-to-be.md'));
        const hasAsIs = existsSync(path.join(modulePath, 'as-is.md'));
        const hasToBe = existsSync(path.join(modulePath, 'to-be.md'));

        if (!hasReviewedToBe) {
          return { success: false, error: 'Missing required file: reviewed-to-be.md' };
        }

        const tasksDir = path.join(modulePath, 'tasks');
        if (!existsSync(tasksDir)) {
          return { success: false, error: 'Missing required directory: tasks/' };
        }

        // Find numbered task files (e.g., 001-domain-entities.md)
        const taskFiles = readdirSync(tasksDir)
          .filter(f => /^\d{3}-.*\.md$/.test(f) && f !== 'README.md')
          .sort();

        if (taskFiles.length === 0) {
          return { success: false, error: 'No task files found in tasks/ directory' };
        }

        // Group tasks into phases by number range
        const phaseMap = new Map<number, { name: string; count: number; taskNumbers: number[] }>();
        for (const file of taskFiles) {
          const num = parseInt(file.substring(0, 3), 10);
          const phaseInfo = getPhaseForTask(num);
          if (phaseInfo) {
            const existing = phaseMap.get(phaseInfo.phase);
            if (existing) {
              existing.count++;
              existing.taskNumbers.push(num);
            } else {
              phaseMap.set(phaseInfo.phase, {
                name: phaseInfo.name,
                count: 1,
                taskNumbers: [num],
              });
            }
          }
        }

        // Build phases array with dependency info
        const phases = Array.from(phaseMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([phase, info]) => ({
            phase,
            name: info.name,
            taskCount: info.count,
            dependsOn: [] as number[], // Simplified — full dependency analysis is in Python
          }));

        // Derive module name from parent directory
        const moduleName = path.basename(modulePath);

        return {
          success: true,
          data: {
            moduleName,
            taskCount: taskFiles.length,
            phases,
            hasReviewedToBe,
            hasAsIs,
            hasToBe,
            taskFiles,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `Validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        };
      }
    }
  );

  // Execute module import via Python backend
  ipcMain.handle(
    IPC_CHANNELS.MODULE_IMPORT_EXECUTE,
    async (_, projectId: string, modulePath: string): Promise<IPCResult<ModuleImportResult>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // Find skills_importer.py — check multiple locations (both dev and production)
        const autoBuildSource = getAutoBuildSourcePath();
        const importerFile = path.join('importers', 'skills_importer.py');
        const candidatePaths = [
          // 1. Global auto-build source path (from settings)
          autoBuildSource ? path.join(autoBuildSource, importerFile) : null,
          // 2. Relative to __dirname (dev: out/main -> apps/backend)
          path.resolve(__dirname, '..', '..', '..', 'backend', importerFile),
          // 3. Relative to cwd (repo root -> apps/backend)
          path.resolve(process.cwd(), 'apps', 'backend', importerFile),
          // 4. Packaged app: process.resourcesPath/backend
          path.resolve(process.resourcesPath, 'backend', importerFile),
          // 5. Packaged app: sibling to asar
          path.resolve(app.getAppPath(), '..', 'backend', importerFile),
        ].filter((p): p is string => p !== null);

        const importerPath = candidatePaths.find(p => existsSync(p));
        if (!importerPath) {
          return { success: false, error: `skills_importer.py not found. Searched: ${candidatePaths.join(', ')}` };
        }

        // The auto-build source is the parent of importers/
        const effectiveAutoBuildSource = path.dirname(path.dirname(importerPath));

        // Find any Python 3 — skills_importer.py is stdlib-only and 3.9+ compatible,
        // so we don't need a venv or Python 3.10+
        const pythonCmd = findPythonCommand() || 'python3';

        // Inline script that imports and runs the importer directly,
        // bypassing run.py (which enforces Python 3.10+ and needs dependencies)
        const inlineScript = [
          'import sys, json',
          `sys.path.insert(0, ${JSON.stringify(effectiveAutoBuildSource)})`,
          'from pathlib import Path',
          'from importers.skills_importer import import_module',
          `spec_dir = import_module(Path(${JSON.stringify(modulePath)}), Path(${JSON.stringify(project.path)}))`,
          'print(json.dumps({"spec_dir": str(spec_dir), "spec_name": spec_dir.name}))',
        ].join('; ');

        const { stdout, stderr } = await execFileAsync(
          pythonCmd,
          ['-c', inlineScript],
          {
            cwd: project.path,
            timeout: 60000,
            env: {
              ...process.env,
              PYTHONUNBUFFERED: '1',
              PYTHONUTF8: '1',
            },
          }
        );

        // Parse the spec directory from the JSON output
        let specId: string;
        let specDir: string;
        try {
          // The inline script prints a JSON line as the last output
          const lines = stdout.trim().split('\n');
          const jsonLine = lines[lines.length - 1];
          const result = JSON.parse(jsonLine);
          specDir = result.spec_dir;
          specId = result.spec_name;
        } catch {
          // Fallback: scan specs directory for the most recent import
          const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
          if (!existsSync(specsDir)) {
            return { success: false, error: `Import may have failed. Specs directory not found. Stderr: ${stderr}` };
          }

          const specDirs = readdirSync(specsDir)
            .filter(d => existsSync(path.join(specsDir, d, 'task_context.json')))
            .sort();

          if (specDirs.length === 0) {
            return { success: false, error: `Import completed but no spec found. Output: ${stdout}. Stderr: ${stderr}` };
          }

          specId = specDirs[specDirs.length - 1];
          specDir = path.join(specsDir, specId);
        }

        // Write task_metadata.json for proper frontend integration
        const metadata: TaskMetadata = {
          sourceType: 'module_import',
          moduleImportPath: modulePath,
          category: 'feature',
          skipPlanning: true,
        };
        writeFileSync(
          path.join(specDir, 'task_metadata.json'),
          JSON.stringify(metadata, null, 2),
          'utf-8'
        );

        // Count tasks and phases from the generated plan
        let taskCount = 0;
        let phaseCount = 0;
        try {
          const planPath = path.join(specDir, 'implementation_plan.json');
          if (existsSync(planPath)) {
            const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
            const phases = plan.phases || [];
            phaseCount = phases.length;
            taskCount = phases.reduce(
              (sum: number, p: { subtasks?: unknown[] }) => sum + (p.subtasks?.length || 0),
              0
            );
          }
        } catch {
          // Non-critical — just return 0s
        }

        // Invalidate task cache so the new task appears
        projectStore.invalidateTasksCache(projectId);

        return {
          success: true,
          data: {
            specId,
            specDir,
            taskCount,
            phaseCount,
          },
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        return {
          success: false,
          error: `Import failed: ${errorMsg}`,
        };
      }
    }
  );
}
