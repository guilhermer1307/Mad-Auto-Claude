/**
 * ChatView Component
 *
 * Main container for the multi-worktree chat system
 * Replaces the Insights component
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MessagesSquare } from 'lucide-react';
import { useChatStore } from '../../stores/chat-store';
import { ChatTabBar } from './ChatTabBar';
import { ChatSession } from './ChatSession';
import { ChatWorktreeSelector } from './ChatWorktreeSelector';
import { ChatActionBar } from './ChatActionBar';
import type {
  AvailableWorktree,
  ChatWorktreeConfig,
  ChatImageAttachment,
  SendChatMessageRequest,
  ChatToolUsage,
} from '@shared/types/chat';

interface ChatViewProps {
  projectId: string;
}

export function ChatView({ projectId }: ChatViewProps) {
  const { t } = useTranslation('common');

  // Chat store state
  const sessions = useChatStore((state) => state.sessions);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const streamingStates = useChatStore((state) => state.streamingStates);
  const statusMap = useChatStore((state) => state.statusMap);
  const errorMap = useChatStore((state) => state.errorMap);

  // Chat store actions
  const createSession = useChatStore((state) => state.createSession);
  const deleteSession = useChatStore((state) => state.deleteSession);
  const switchSession = useChatStore((state) => state.switchSession);
  const addUserMessage = useChatStore((state) => state.addUserMessage);
  const startStreaming = useChatStore((state) => state.startStreaming);
  const updateStreamingContent = useChatStore((state) => state.updateStreamingContent);
  const addStreamingTool = useChatStore((state) => state.addStreamingTool);
  const finalizeStreamingMessage = useChatStore((state) => state.finalizeStreamingMessage);
  const setStatus = useChatStore((state) => state.setStatus);
  const setError = useChatStore((state) => state.setError);
  const getStatus = useChatStore((state) => state.getStatus);
  const getActiveSession = useChatStore((state) => state.getActiveSession);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const clearAll = useChatStore((state) => state.clearAll);

  const [showWorktreeSelector, setShowWorktreeSelector] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load sessions on mount
  useEffect(() => {
    loadSessionsFromDisk();
  }, [projectId]);

  // Set up IPC listeners
  useEffect(() => {
    const handleStreamChunk = (sessionId: string, chunk: string) => {
      updateStreamingContent(sessionId, chunk);
    };

    const handleToolStart = (sessionId: string, tool: { name: string; input?: string }) => {
      const toolUsage: ChatToolUsage = {
        name: tool.name,
        input: tool.input,
        timestamp: new Date().toISOString(),
      };
      addStreamingTool(sessionId, toolUsage);
      setStatus(sessionId, 'tool_running');
    };

    const handleToolEnd = (sessionId: string) => {
      setStatus(sessionId, 'streaming');
    };

    const handleComplete = (sessionId: string) => {
      finalizeStreamingMessage(sessionId);
      // Save session to disk
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        saveSession(session);
      }
    };

    const handleError = (sessionId: string, error: string) => {
      setError(sessionId, error);
      finalizeStreamingMessage(sessionId);
    };

    const cleanups = [
      window.electronAPI.onChatStreamChunk(handleStreamChunk),
      window.electronAPI.onChatToolStart(handleToolStart),
      window.electronAPI.onChatToolEnd(handleToolEnd),
      window.electronAPI.onChatComplete(handleComplete),
      window.electronAPI.onChatError(handleError),
    ];

    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [sessions]);

  // Clear sessions on project change
  useEffect(() => {
    return () => {
      clearAll();
    };
  }, [projectId]);

  const loadSessionsFromDisk = async () => {
    setLoading(true);
    try {
      const loadedSessions = await window.electronAPI.listChatSessions(projectId);
      if (loadedSessions && loadedSessions.length > 0) {
        loadSessions(loadedSessions);
      } else {
        // Create a default session
        createSession(projectId);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
      // Create a default session on error
      createSession(projectId);
    } finally {
      setLoading(false);
    }
  };

  const saveSession = async (session: Parameters<typeof useChatStore.getState>['0']['sessions'][0]) => {
    try {
      await window.electronAPI.saveChatSession(projectId, session);
    } catch (error) {
      console.error('Failed to save session:', error);
    }
  };

  const handleNewSession = () => {
    setShowWorktreeSelector(true);
  };

  const handleWorktreeSelect = (worktree: AvailableWorktree | null) => {
    let worktreeConfig: ChatWorktreeConfig | null = null;

    if (worktree) {
      worktreeConfig = {
        name: worktree.name,
        worktreePath: worktree.path,
        branchName: worktree.branch,
        baseBranch: worktree.baseBranch,
        taskId: worktree.taskId,
        createdAt: new Date().toISOString(),
      };
    }

    const sessionId = createSession(projectId, worktreeConfig);

    // Save the new session
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      saveSession(session);
    }
  };

  const handleSwitchSession = (sessionId: string) => {
    switchSession(sessionId);
  };

  const handleCloseSession = async (sessionId: string) => {
    // Delete from disk
    try {
      await window.electronAPI.deleteChatSession(projectId, sessionId);
    } catch (error) {
      console.error('Failed to delete session from disk:', error);
    }

    // Delete from store
    deleteSession(sessionId);
  };

  const handleSendMessage = async (message: string, images?: ChatImageAttachment[]) => {
    const session = getActiveSession();
    if (!session) return;

    // Add user message to store (with images)
    addUserMessage(session.id, message, images);

    // Start streaming
    startStreaming(session.id);

    // Build request
    const request: SendChatMessageRequest = {
      projectId,
      sessionId: session.id,
      message,
      modelConfig: session.modelConfig,
      worktreePath: session.worktreeConfig?.worktreePath,
      images,
    };

    try {
      await window.electronAPI.sendChatMessage(request);
    } catch (error) {
      console.error('Failed to send message:', error);
      setError(session.id, error instanceof Error ? error.message : 'Failed to send message');
    }
  };

  const handleMerge = async (targetBranch: string) => {
    const session = getActiveSession();
    if (!session?.worktreeConfig?.taskId) return;

    try {
      const result = await window.electronAPI.mergeWorktree(session.worktreeConfig.taskId, {
        targetBranch,
      });

      if (!result.success) {
        setError(session.id, result.error || 'Merge failed');
      }
    } catch (error) {
      console.error('Failed to merge:', error);
      setError(session.id, error instanceof Error ? error.message : 'Merge failed');
    }
  };

  const handleCreatePR = async () => {
    const session = getActiveSession();
    if (!session?.worktreeConfig?.taskId) return;

    try {
      await window.electronAPI.createPR(session.worktreeConfig.taskId);
    } catch (error) {
      console.error('Failed to create PR:', error);
      setError(session.id, error instanceof Error ? error.message : 'Failed to create PR');
    }
  };

  const handleDiscard = async () => {
    const session = getActiveSession();
    if (!session?.worktreeConfig?.taskId) return;

    if (confirm(t('chat.confirmDiscard'))) {
      try {
        await window.electronAPI.deleteWorktree(session.worktreeConfig.taskId);
        // Also delete the chat session
        handleCloseSession(session.id);
      } catch (error) {
        console.error('Failed to discard worktree:', error);
        setError(session.id, error instanceof Error ? error.message : 'Failed to discard');
      }
    }
  };

  const activeSession = getActiveSession();
  const streamingContent = activeSessionId ? streamingStates.get(activeSessionId)?.content || '' : '';
  const currentTool = activeSessionId ? streamingStates.get(activeSessionId)?.toolsUsed.slice(-1)[0] : undefined;
  const status = activeSessionId ? getStatus(activeSessionId) : 'idle';
  const error = activeSessionId ? errorMap.get(activeSessionId) : null;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <MessagesSquare className="h-12 w-12 mx-auto mb-4 text-muted-foreground animate-pulse" />
          <p className="text-sm text-muted-foreground">Loading chat sessions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab Bar */}
      <ChatTabBar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSwitchSession={handleSwitchSession}
        onCloseSession={handleCloseSession}
        onNewSession={handleNewSession}
      />

      {/* Active Chat Session */}
      {activeSession && (
        <ChatSession
          session={activeSession}
          isActive={true}
          status={status}
          streamingContent={streamingContent}
          currentTool={currentTool}
          error={error}
          onSendMessage={handleSendMessage}
        />
      )}

      {/* Action Bar (only for worktree-attached sessions) */}
      {activeSession && (
        <ChatActionBar
          session={activeSession}
          onMerge={handleMerge}
          onCreatePR={handleCreatePR}
          onDiscard={handleDiscard}
          disabled={status === 'streaming' || status === 'tool_running'}
        />
      )}

      {/* Worktree Selector Dialog */}
      <ChatWorktreeSelector
        open={showWorktreeSelector}
        onClose={() => setShowWorktreeSelector(false)}
        onSelect={handleWorktreeSelect}
        projectId={projectId}
      />
    </div>
  );
}
