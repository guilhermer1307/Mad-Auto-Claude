/**
 * Chat store - Zustand state management for multi-worktree chat system
 */

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type {
  ChatSession,
  ChatMessage,
  ChatStreamingState,
  ChatStatus,
  ChatWorktreeConfig,
  ChatModelConfig,
  ChatToolUsage,
  ChatImageAttachment,
} from '@shared/types/chat';

interface ChatState {
  // ===== State =====
  /** All chat sessions */
  sessions: ChatSession[];
  /** Currently active session ID */
  activeSessionId: string | null;
  /** Streaming state per session */
  streamingStates: Map<string, ChatStreamingState>;
  /** Status per session */
  statusMap: Map<string, ChatStatus>;
  /** Error messages per session */
  errorMap: Map<string, string | null>;

  // ===== Session Management Actions =====
  /**
   * Create a new chat session
   * @param projectId Project ID
   * @param worktreeConfig Optional worktree configuration
   * @param title Optional session title
   * @param modelConfig Optional model configuration
   * @returns New session ID
   */
  createSession: (
    projectId: string,
    worktreeConfig?: ChatWorktreeConfig | null,
    title?: string,
    modelConfig?: ChatModelConfig
  ) => string;

  /**
   * Delete a chat session
   * @param sessionId Session ID to delete
   */
  deleteSession: (sessionId: string) => void;

  /**
   * Switch to a different session
   * @param sessionId Session ID to activate
   */
  switchSession: (sessionId: string) => void;

  /**
   * Reorder sessions (for drag-and-drop)
   * @param oldIndex Current index
   * @param newIndex New index
   */
  reorderSessions: (oldIndex: number, newIndex: number) => void;

  /**
   * Update session title
   * @param sessionId Session ID
   * @param title New title
   */
  updateSessionTitle: (sessionId: string, title: string) => void;

  /**
   * Update session model config
   * @param sessionId Session ID
   * @param modelConfig New model configuration
   */
  updateSessionModelConfig: (sessionId: string, modelConfig: ChatModelConfig) => void;

  /**
   * Load sessions from persistence
   * @param sessions Array of sessions to load
   */
  loadSessions: (sessions: ChatSession[]) => void;

  /**
   * Get active session
   * @returns Active session or null
   */
  getActiveSession: () => ChatSession | null;

  /**
   * Get session by ID
   * @param sessionId Session ID
   * @returns Session or null
   */
  getSession: (sessionId: string) => ChatSession | null;

  // ===== Message Actions =====
  /**
   * Add a user message to a session
   * @param sessionId Session ID
   * @param content Message content
   * @param images Optional image attachments
   * @returns Message ID
   */
  addUserMessage: (sessionId: string, content: string, images?: ChatImageAttachment[]) => string;

  /**
   * Add an assistant message to a session
   * @param sessionId Session ID
   * @param content Message content
   * @param toolsUsed Optional tools used
   * @returns Message ID
   */
  addAssistantMessage: (
    sessionId: string,
    content: string,
    toolsUsed?: ChatToolUsage[]
  ) => string;

  // ===== Streaming Actions =====
  /**
   * Start streaming for a session
   * @param sessionId Session ID
   */
  startStreaming: (sessionId: string) => void;

  /**
   * Update streaming content
   * @param sessionId Session ID
   * @param chunk Content chunk to append
   */
  updateStreamingContent: (sessionId: string, chunk: string) => void;

  /**
   * Add tool usage to streaming state
   * @param sessionId Session ID
   * @param tool Tool usage info
   */
  addStreamingTool: (sessionId: string, tool: ChatToolUsage) => void;

  /**
   * Finalize streaming and convert to message
   * @param sessionId Session ID
   */
  finalizeStreamingMessage: (sessionId: string) => void;

  /**
   * Cancel streaming
   * @param sessionId Session ID
   */
  cancelStreaming: (sessionId: string) => void;

  // ===== Status Actions =====
  /**
   * Set session status
   * @param sessionId Session ID
   * @param status New status
   */
  setStatus: (sessionId: string, status: ChatStatus) => void;

  /**
   * Set session error
   * @param sessionId Session ID
   * @param error Error message or null to clear
   */
  setError: (sessionId: string, error: string | null) => void;

  /**
   * Get session status
   * @param sessionId Session ID
   * @returns Current status
   */
  getStatus: (sessionId: string) => ChatStatus;

  // ===== Cleanup =====
  /**
   * Clear all sessions (for project switch)
   */
  clearAll: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  // ===== Initial State =====
  sessions: [],
  activeSessionId: null,
  streamingStates: new Map(),
  statusMap: new Map(),
  errorMap: new Map(),

  // ===== Session Management =====
  createSession: (projectId, worktreeConfig, title, modelConfig) => {
    const newSessionId = uuidv4();
    const now = new Date().toISOString();

    const newSession: ChatSession = {
      id: newSessionId,
      projectId,
      title,
      worktreeConfig: worktreeConfig || null,
      messages: [],
      modelConfig,
      createdAt: now,
      updatedAt: now,
      displayOrder: get().sessions.length,
    };

    set((state) => ({
      sessions: [...state.sessions, newSession],
      activeSessionId: newSessionId,
    }));

    // Initialize status
    get().statusMap.set(newSessionId, 'idle');

    return newSessionId;
  },

  deleteSession: (sessionId) => {
    set((state) => {
      const newSessions = state.sessions.filter((s) => s.id !== sessionId);
      let newActiveId = state.activeSessionId;

      // If deleting active session, switch to another
      if (state.activeSessionId === sessionId) {
        newActiveId = newSessions.length > 0 ? newSessions[0].id : null;
      }

      return {
        sessions: newSessions,
        activeSessionId: newActiveId,
      };
    });

    // Cleanup maps
    get().streamingStates.delete(sessionId);
    get().statusMap.delete(sessionId);
    get().errorMap.delete(sessionId);
  },

  switchSession: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

  reorderSessions: (oldIndex, newIndex) => {
    set((state) => {
      const newSessions = [...state.sessions];
      const [movedSession] = newSessions.splice(oldIndex, 1);
      newSessions.splice(newIndex, 0, movedSession);

      // Update display order
      return {
        sessions: newSessions.map((session, index) => ({
          ...session,
          displayOrder: index,
        })),
      };
    });
  },

  updateSessionTitle: (sessionId, title) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, title, updatedAt: new Date().toISOString() }
          : session
      ),
    }));
  },

  updateSessionModelConfig: (sessionId, modelConfig) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, modelConfig, updatedAt: new Date().toISOString() }
          : session
      ),
    }));
  },

  loadSessions: (sessions) => {
    set({
      sessions,
      activeSessionId: sessions.length > 0 ? sessions[0].id : null,
    });

    // Initialize status for all sessions
    const statusMap = get().statusMap;
    for (const session of sessions) {
      if (!statusMap.has(session.id)) {
        statusMap.set(session.id, 'idle');
      }
    }
  },

  getActiveSession: () => {
    const state = get();
    return state.sessions.find((s) => s.id === state.activeSessionId) || null;
  },

  getSession: (sessionId) => {
    return get().sessions.find((s) => s.id === sessionId) || null;
  },

  // ===== Message Management =====
  addUserMessage: (sessionId, content, images) => {
    const messageId = uuidv4();
    const now = new Date().toISOString();

    const newMessage: ChatMessage = {
      id: messageId,
      role: 'user',
      content,
      timestamp: now,
      images: images && images.length > 0 ? images : undefined,
    };

    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: [...session.messages, newMessage],
              updatedAt: now,
            }
          : session
      ),
    }));

    return messageId;
  },

  addAssistantMessage: (sessionId, content, toolsUsed) => {
    const messageId = uuidv4();
    const now = new Date().toISOString();

    const newMessage: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content,
      timestamp: now,
      toolsUsed,
    };

    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              messages: [...session.messages, newMessage],
              updatedAt: now,
            }
          : session
      ),
    }));

    return messageId;
  },

  // ===== Streaming Management =====
  startStreaming: (sessionId) => {
    const streamingStates = get().streamingStates;
    streamingStates.set(sessionId, {
      content: '',
      toolsUsed: [],
    });

    get().setStatus(sessionId, 'streaming');
  },

  updateStreamingContent: (sessionId, chunk) => {
    const streamingStates = get().streamingStates;
    const currentState = streamingStates.get(sessionId);

    if (currentState) {
      streamingStates.set(sessionId, {
        ...currentState,
        content: currentState.content + chunk,
      });

      // Trigger re-render
      set({ streamingStates: new Map(streamingStates) });
    }
  },

  addStreamingTool: (sessionId, tool) => {
    const streamingStates = get().streamingStates;
    const currentState = streamingStates.get(sessionId);

    if (currentState) {
      streamingStates.set(sessionId, {
        ...currentState,
        toolsUsed: [...currentState.toolsUsed, tool],
      });

      get().setStatus(sessionId, 'tool_running');
      set({ streamingStates: new Map(streamingStates) });
    }
  },

  finalizeStreamingMessage: (sessionId) => {
    const streamingStates = get().streamingStates;
    const streamingState = streamingStates.get(sessionId);

    if (streamingState && streamingState.content.trim()) {
      get().addAssistantMessage(
        sessionId,
        streamingState.content,
        streamingState.toolsUsed
      );
    }

    streamingStates.delete(sessionId);
    set({ streamingStates: new Map(streamingStates) });

    get().setStatus(sessionId, 'idle');
  },

  cancelStreaming: (sessionId) => {
    const streamingStates = get().streamingStates;
    streamingStates.delete(sessionId);
    set({ streamingStates: new Map(streamingStates) });

    get().setStatus(sessionId, 'idle');
  },

  // ===== Status Management =====
  setStatus: (sessionId, status) => {
    const statusMap = get().statusMap;
    statusMap.set(sessionId, status);
    set({ statusMap: new Map(statusMap) });
  },

  setError: (sessionId, error) => {
    const errorMap = get().errorMap;
    if (error) {
      errorMap.set(sessionId, error);
      get().setStatus(sessionId, 'error');
    } else {
      errorMap.delete(sessionId);
    }
    set({ errorMap: new Map(errorMap) });
  },

  getStatus: (sessionId) => {
    return get().statusMap.get(sessionId) || 'idle';
  },

  // ===== Cleanup =====
  clearAll: () => {
    set({
      sessions: [],
      activeSessionId: null,
      streamingStates: new Map(),
      statusMap: new Map(),
      errorMap: new Map(),
    });
  },
}));
