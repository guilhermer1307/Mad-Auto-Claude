/**
 * ChatWorktreeSelector Component
 *
 * Modal dialog for selecting a worktree when creating a new chat session
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Search, Folder, Terminal, CheckSquare } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { Badge } from '../ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { cn } from '../../lib/utils';
import type { AvailableWorktree } from '@shared/types/chat';

interface ChatWorktreeSelectorProps {
  open: boolean;
  onClose: () => void;
  onSelect: (worktree: AvailableWorktree | null) => void; // null = main project
  projectId: string;
}

export function ChatWorktreeSelector({
  open,
  onClose,
  onSelect,
  projectId,
}: ChatWorktreeSelectorProps) {
  const { t } = useTranslation('common');
  const [worktrees, setWorktrees] = useState<AvailableWorktree[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('develop');
  const [creating, setCreating] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);

  useEffect(() => {
    if (open && projectId) {
      loadWorktrees();
      loadBranches();
    }
  }, [open, projectId]);

  const loadWorktrees = async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.listChatWorktrees(projectId);
      setWorktrees(result);
    } catch (error) {
      console.error('Failed to load worktrees:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadBranches = async () => {
    try {
      const result = await window.electronAPI.listChatBranches(projectId);
      setBranches(result);
      // Set default to 'develop' if it exists, otherwise first branch
      if (result.includes('develop')) {
        setBaseBranch('develop');
      } else if (result.length > 0) {
        setBaseBranch(result[0]);
      }
    } catch (error) {
      console.error('Failed to load branches:', error);
      setBranches(['develop', 'main', 'master']); // Fallback
      setBaseBranch('develop');
    }
  };

  const handleSelect = (worktree: AvailableWorktree | null) => {
    onSelect(worktree);
    onClose();
    setSearchQuery('');
    setShowCreateForm(false);
    setBranchName('');
    setBaseBranch(branches.includes('develop') ? 'develop' : branches[0] || 'develop');
  };

  const handleCreateWorktree = async () => {
    if (!branchName.trim()) return;

    setCreating(true);
    try {
      const result = await window.electronAPI.createChatWorktree(
        projectId,
        branchName.trim(),
        baseBranch || 'develop',
      );

      if (result.success && result.worktreePath) {
        // Create AvailableWorktree object for the new worktree
        const newWorktree: AvailableWorktree = {
          name: branchName.trim(),
          path: result.worktreePath,
          branch: result.branch || branchName.trim(),
          baseBranch: baseBranch || 'develop',
          type: 'terminal',
        };

        handleSelect(newWorktree);
      } else {
        console.error('Failed to create worktree:', result.error);
        alert(`Failed to create worktree: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Failed to create worktree:', error);
      alert(`Failed to create worktree: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setCreating(false);
      setBranchName('');
      setBaseBranch(branches.includes('develop') ? 'develop' : branches[0] || 'develop');
    }
  };

  const filteredWorktrees = worktrees.filter((wt) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      wt.name.toLowerCase().includes(query) ||
      wt.branch.toLowerCase().includes(query) ||
      wt.taskId?.toLowerCase().includes(query)
    );
  });

  const getWorktreeIcon = (type: 'task' | 'terminal' | 'manual') => {
    switch (type) {
      case 'task':
        return CheckSquare;
      case 'terminal':
        return Terminal;
      default:
        return Folder;
    }
  };

  const getWorktreeBadgeColor = (type: 'task' | 'terminal' | 'manual') => {
    switch (type) {
      case 'task':
        return 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20';
      case 'terminal':
        return 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20';
      default:
        return 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20';
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('chat.selectWorktree')}</DialogTitle>
          <DialogDescription>
            {t('chat.selectWorktreeDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('chat.searchWorktrees')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Main Project Option */}
          <button
            onClick={() => handleSelect(null)}
            className={cn(
              'w-full flex items-center gap-3 rounded-lg border-2 p-4 text-left transition-all',
              'hover:bg-muted hover:border-primary/50',
              'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2'
            )}
            type="button"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
              <GitBranch className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1">
              <div className="font-medium text-foreground">{t('chat.mainProject')}</div>
              <div className="text-sm text-muted-foreground">
                {t('chat.mainProjectDescription')}
              </div>
            </div>
            <Badge
              variant="outline"
              className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
            >
              main
            </Badge>
          </button>

          {/* Create Worktree Section */}
          {!showCreateForm ? (
            <button
              onClick={() => setShowCreateForm(true)}
              className={cn(
                'w-full flex items-center gap-3 rounded-lg border-2 border-dashed p-4 text-left transition-all',
                'hover:bg-muted hover:border-primary/50',
                'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2'
              )}
              type="button"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10">
                <Terminal className="h-5 w-5 text-purple-600 dark:text-purple-400" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-foreground">{t('chat.createNewWorktree')}</div>
                <div className="text-sm text-muted-foreground">
                  {t('chat.createNewWorktreeDescription')}
                </div>
              </div>
            </button>
          ) : (
            <div className="rounded-lg border-2 border-purple-500/20 bg-purple-500/5 p-4 space-y-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium text-foreground">{t('chat.createNewWorktree')}</div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowCreateForm(false);
                    setBranchName('');
                    setBaseBranch(branches.includes('develop') ? 'develop' : branches[0] || 'develop');
                  }}
                >
                  {t('buttons.cancel')}
                </Button>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  {t('chat.branchName')}
                </label>
                <Input
                  placeholder={t('chat.branchNamePlaceholder')}
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  disabled={creating}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  {t('chat.baseBranch')}
                </label>
                <Select
                  value={baseBranch}
                  onValueChange={setBaseBranch}
                  disabled={creating}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('chat.selectBaseBranch')} />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                onClick={handleCreateWorktree}
                disabled={creating || !branchName.trim()}
                className="w-full"
              >
                {creating ? t('chat.creating') : t('chat.createWorktree')}
              </Button>
            </div>
          )}

          {/* Worktrees List */}
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              {t('chat.loadingWorktrees')}
            </div>
          ) : filteredWorktrees.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground">
              <Folder className="h-12 w-12 mb-2 opacity-50" />
              {searchQuery ? t('chat.noWorktreesMatch') : t('chat.noWorktreesAvailable')}
            </div>
          ) : (
            <ScrollArea className="max-h-[400px]">
              <div className="space-y-2">
                {filteredWorktrees.map((worktree) => {
                  const Icon = getWorktreeIcon(worktree.type);
                  const badgeColor = getWorktreeBadgeColor(worktree.type);

                  return (
                    <button
                      key={worktree.path}
                      onClick={() => handleSelect(worktree)}
                      className={cn(
                        'w-full flex items-center gap-3 rounded-lg border-2 p-4 text-left transition-all',
                        'hover:bg-muted hover:border-primary/50',
                        'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2'
                      )}
                      type="button"
                    >
                      <div className={cn(
                        'flex h-10 w-10 items-center justify-center rounded-lg',
                        worktree.type === 'task'
                          ? 'bg-green-500/10'
                          : worktree.type === 'terminal'
                          ? 'bg-purple-500/10'
                          : 'bg-gray-500/10'
                      )}>
                        <Icon className={cn(
                          'h-5 w-5',
                          worktree.type === 'task'
                            ? 'text-green-600 dark:text-green-400'
                            : worktree.type === 'terminal'
                            ? 'text-purple-600 dark:text-purple-400'
                            : 'text-gray-600 dark:text-gray-400'
                        )} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-foreground truncate">
                          {worktree.name}
                        </div>
                        <div className="text-sm text-muted-foreground flex items-center gap-2">
                          <GitBranch className="h-3 w-3" />
                          <span className="truncate">{worktree.branch}</span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1 items-end">
                        <Badge variant="outline" className={badgeColor}>
                          {worktree.type}
                        </Badge>
                        {worktree.taskId && (
                          <span className="text-xs text-muted-foreground">
                            #{worktree.taskId}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t('buttons.cancel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
