/**
 * ModuleImportModal - Dialog for importing external module specs
 *
 * Allows users to browse to a module folder (from an external skills project),
 * preview its phases/tasks, and import it into the current Auto Claude project.
 */
import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { loadTasks, startTask } from '../../stores/task-store';
import type { ModuleValidationResult, ModuleImportResult } from '../../../shared/types';

type Step = 'select' | 'preview' | 'importing' | 'complete' | 'error';

interface ModuleImportModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ModuleImportModal({ projectId, open, onOpenChange }: ModuleImportModalProps) {
  const { t } = useTranslation(['tasks', 'common']);

  const [step, setStep] = useState<Step>('select');
  const [modulePath, setModulePath] = useState<string>('');
  const [validationResult, setValidationResult] = useState<ModuleValidationResult | null>(null);
  const [importResult, setImportResult] = useState<ModuleImportResult | null>(null);
  const [error, setError] = useState<string>('');
  const [isValidating, setIsValidating] = useState(false);

  const reset = useCallback(() => {
    setStep('select');
    setModulePath('');
    setValidationResult(null);
    setImportResult(null);
    setError('');
    setIsValidating(false);
  }, []);

  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen) {
      reset();
    }
    onOpenChange(newOpen);
  }, [onOpenChange, reset]);

  const handleBrowse = useCallback(async () => {
    const selectedPath = await window.electronAPI.selectDirectory();
    if (!selectedPath) return;

    setModulePath(selectedPath);
    setIsValidating(true);
    setError('');

    const result = await window.electronAPI.validateModuleFolder(selectedPath);

    setIsValidating(false);

    if (result.success && result.data) {
      setValidationResult(result.data);
      setStep('preview');
    } else {
      setError(result.error || t('tasks:moduleImport.errors.invalidFolder'));
    }
  }, [t]);

  const handleImport = useCallback(async () => {
    if (!modulePath) return;

    setStep('importing');
    setError('');

    const result = await window.electronAPI.importModule(projectId, modulePath);

    if (result.success && result.data) {
      setImportResult(result.data);
      setStep('complete');
      // Refresh the task list so the new task appears on the board
      await loadTasks(projectId, { forceRefresh: true });
    } else {
      setError(result.error || t('tasks:moduleImport.errors.importFailed', { error: 'Unknown' }));
      setStep('error');
    }
  }, [projectId, modulePath, t]);

  const handleViewOnBoard = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  const handleStartBuilding = useCallback(() => {
    if (importResult?.specId) {
      startTask(importResult.specId);
    }
    handleOpenChange(false);
  }, [importResult, handleOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('tasks:moduleImport.title')}</DialogTitle>
          <DialogDescription>{t('tasks:moduleImport.description')}</DialogDescription>
        </DialogHeader>

        {/* Step 1: Select folder */}
        {step === 'select' && (
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              {t('tasks:moduleImport.browsePlaceholder')}
            </p>

            <div className="flex gap-2 items-center">
              <div className="flex-1 px-3 py-2 rounded-md border border-border bg-muted/50 text-sm truncate min-h-[36px]">
                {modulePath || <span className="text-muted-foreground">...</span>}
              </div>
              <Button onClick={handleBrowse} disabled={isValidating}>
                {isValidating ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <FolderOpen className="h-4 w-4 mr-2" />
                )}
                {t('tasks:moduleImport.browse')}
              </Button>
            </div>

            {isValidating && (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('tasks:moduleImport.validating')}
              </p>
            )}

            {error && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Preview */}
        {step === 'preview' && validationResult && (
          <div className="space-y-4 py-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {t('tasks:moduleImport.preview.moduleName')}: {validationResult.moduleName}
              </span>
              <span className="text-sm text-muted-foreground">
                {t('tasks:moduleImport.preview.taskCount', {
                  count: validationResult.taskCount,
                  phases: validationResult.phases.length,
                })}
              </span>
            </div>

            <div className="rounded-md border border-border divide-y divide-border max-h-[300px] overflow-y-auto">
              {validationResult.phases.map((phase) => (
                <div key={phase.phase} className="px-3 py-2 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {t('tasks:moduleImport.preview.phase', { number: phase.phase })}:
                    </span>
                    <span className="text-muted-foreground">{phase.name}</span>
                  </div>
                  <span className="text-muted-foreground shrink-0">
                    {t('tasks:moduleImport.preview.tasks', { count: phase.taskCount })}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {validationResult.hasReviewedToBe ? '\u2713' : '\u2717'} reviewed-to-be.md
              </span>
              <span>
                {validationResult.hasAsIs ? '\u2713' : '\u2717'} as-is.md
              </span>
              <span>
                {validationResult.hasToBe ? '\u2713' : '\u2717'} to-be.md
              </span>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { reset(); }}>
                {t('common:buttons.cancel')}
              </Button>
              <Button onClick={handleImport}>
                {t('tasks:moduleImport.import')}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3: Importing */}
        {step === 'importing' && (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              {t('tasks:moduleImport.importing')}
            </p>
          </div>
        )}

        {/* Step 4: Complete */}
        {step === 'complete' && importResult && (
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-8 w-8 text-green-500 shrink-0" />
              <div>
                <p className="font-medium">{t('tasks:moduleImport.complete.title')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('tasks:moduleImport.complete.message', {
                    count: importResult.taskCount,
                    specId: importResult.specId,
                  })}
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleViewOnBoard}>
                {t('tasks:moduleImport.complete.viewOnBoard')}
              </Button>
              <Button onClick={handleStartBuilding}>
                {t('tasks:moduleImport.complete.startBuilding')}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Error state */}
        {step === 'error' && (
          <div className="space-y-4 py-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-8 w-8 text-destructive shrink-0" />
              <div>
                <p className="font-medium text-destructive">
                  {t('tasks:moduleImport.errors.importFailed', { error: '' })}
                </p>
                <p className="text-sm text-muted-foreground mt-1">{error}</p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { reset(); }}>
                {t('common:buttons.back')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
