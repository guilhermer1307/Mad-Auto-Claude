/**
 * ChatActionBar Component
 *
 * Bottom action bar for worktree-attached chat sessions
 * Provides merge, create PR, and discard actions
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitMerge, GitPullRequest, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Input } from '../ui/input';
import type { ChatSession } from '@shared/types/chat';

interface ChatActionBarProps {
  session: ChatSession;
  onMerge: (targetBranch: string) => void;
  onCreatePR: () => void;
  onDiscard: () => void;
  disabled?: boolean;
}

export function ChatActionBar({
  session,
  onMerge,
  onCreatePR,
  onDiscard,
  disabled = false,
}: ChatActionBarProps) {
  const { t } = useTranslation(['common', 'taskReview']);

  // Only show action bar if session is attached to a worktree
  if (!session.worktreeConfig) {
    return null;
  }

  const { branchName, baseBranch } = session.worktreeConfig;
  const defaultBranch = baseBranch || 'develop';

  const [targetBranch, setTargetBranch] = useState<string>(defaultBranch);
  const [customBranch, setCustomBranch] = useState<string>('');

  const handleMerge = () => {
    const branch = targetBranch === 'custom' ? customBranch : targetBranch;
    if (branch.trim()) {
      onMerge(branch);
    }
  };

  return (
    <div className="flex-shrink-0 border-t border-border bg-muted/30 p-4">
      <div className="flex items-center gap-3">
        {/* Branch selector */}
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <span className="text-sm text-muted-foreground shrink-0">
            {t('taskReview.targetBranch')}:
          </span>
          <Select
            value={targetBranch === 'custom' ? 'custom' : targetBranch}
            onValueChange={(value) => {
              setTargetBranch(value);
              if (value !== 'custom') setCustomBranch('');
            }}
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {branchName && branchName !== baseBranch && (
                <SelectItem value={branchName}>
                  {branchName} (current)
                </SelectItem>
              )}
              {baseBranch && (
                <SelectItem value={baseBranch}>
                  {baseBranch} (base)
                </SelectItem>
              )}
              <SelectItem value="custom">Custom branch...</SelectItem>
            </SelectContent>
          </Select>

          {targetBranch === 'custom' && (
            <Input
              placeholder="Enter branch name"
              value={customBranch}
              onChange={(e) => setCustomBranch(e.target.value)}
              className="w-48"
              disabled={disabled}
            />
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 ml-auto">
          <Button
            onClick={handleMerge}
            disabled={disabled || (targetBranch === 'custom' && !customBranch.trim())}
            variant="default"
          >
            <GitMerge className="mr-2 h-4 w-4" />
            {t('taskReview.merge')} to {targetBranch === 'custom' ? (customBranch || '...') : targetBranch}
          </Button>

          <Button
            onClick={onCreatePR}
            disabled={disabled}
            variant="outline"
          >
            <GitPullRequest className="mr-2 h-4 w-4" />
            {t('taskReview.createPR')}
          </Button>

          <Button
            onClick={onDiscard}
            disabled={disabled}
            variant="outline"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('taskReview.discard')}
          </Button>
        </div>
      </div>
    </div>
  );
}
