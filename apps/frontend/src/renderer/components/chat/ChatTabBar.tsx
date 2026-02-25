/**
 * ChatTabBar Component
 *
 * Horizontal tab bar for switching between chat sessions
 */

import { useTranslation } from 'react-i18next';
import { Plus, X, GitBranch } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { ChatSession } from '@shared/types/chat';

interface ChatTabBarProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSwitchSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onNewSession: () => void;
}

export function ChatTabBar({
  sessions,
  activeSessionId,
  onSwitchSession,
  onCloseSession,
  onNewSession,
}: ChatTabBarProps) {
  const { t } = useTranslation('common');

  const getWorktreeBadgeColor = (type: 'task' | 'terminal' | 'main' = 'main') => {
    switch (type) {
      case 'task':
        return 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20';
      case 'terminal':
        return 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20';
      case 'main':
      default:
        return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20';
    }
  };

  const getWorktreeType = (session: ChatSession): 'task' | 'terminal' | 'main' => {
    if (!session.worktreeConfig) return 'main';
    const { worktreePath } = session.worktreeConfig;
    if (worktreePath.includes('/tasks/')) return 'task';
    if (worktreePath.includes('/terminal/')) return 'terminal';
    return 'main';
  };

  const getSessionTitle = (session: ChatSession): string => {
    if (session.title) return session.title;
    if (session.worktreeConfig) {
      return `${session.worktreeConfig.branchName}`;
    }
    return 'Main Project';
  };

  const handleCloseSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (sessions.length <= 1) {
      // Don't close the last session
      return;
    }
    onCloseSession(sessionId);
  };

  return (
    <div className="flex items-center border-b border-border bg-background px-2 py-1 gap-1 overflow-x-auto">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        const worktreeType = getWorktreeType(session);
        const badgeColor = getWorktreeBadgeColor(worktreeType);
        const title = getSessionTitle(session);

        return (
          <div
            key={session.id}
            className={cn(
              'group relative flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer transition-colors min-w-[120px] max-w-[200px]',
              isActive
                ? 'bg-primary/10 text-foreground border border-primary/20'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent'
            )}
            onClick={() => onSwitchSession(session.id)}
          >
            <div className="flex-1 flex items-center gap-2 min-w-0">
              {session.worktreeConfig && (
                <GitBranch className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate font-medium">{title}</span>
            </div>

            {session.worktreeConfig && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1 py-0 h-4 shrink-0', badgeColor)}
              >
                {session.worktreeConfig.taskId || session.worktreeConfig.name.split('/').pop()}
              </Badge>
            )}

            {sessions.length > 1 && (
              <button
                onClick={(e) => handleCloseSession(e, session.id)}
                className="ml-1 opacity-0 group-hover:opacity-100 hover:bg-destructive/20 rounded p-0.5 transition-opacity"
                type="button"
                aria-label={t('chat.closeSession')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}

      {/* New Session Button */}
      {sessions.length < 12 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewSession}
          className="shrink-0 h-8"
        >
          <Plus className="h-4 w-4" />
        </Button>
      )}

      {sessions.length >= 12 && (
        <span className="text-xs text-muted-foreground px-2">
          Max sessions reached
        </span>
      )}
    </div>
  );
}
