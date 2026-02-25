/**
 * Chat API - Preload bridge for multi-worktree chat IPC communication
 */

import type {
  ChatSession,
  ChatOperationResult,
  ChatImageAttachment,
  CreateChatSessionRequest,
  SendChatMessageRequest,
  AvailableWorktree,
} from '../../../shared/types/chat';
import { createIpcListener, invokeIpc, IpcListenerCleanup } from './ipc-utils';

/**
 * Chat API operations
 */
export interface ChatAPI {
  // Session Management
  createChatSession: (request: CreateChatSessionRequest) => Promise<ChatOperationResult>;
  deleteChatSession: (projectId: string, sessionId: string) => Promise<ChatOperationResult>;
  listChatSessions: (projectId: string) => Promise<ChatSession[]>;
  saveChatSession: (projectId: string, session: ChatSession) => Promise<ChatOperationResult>;
  saveChatSessions: (projectId: string, sessions: ChatSession[]) => Promise<ChatOperationResult>;

  // Messaging
  sendChatMessage: (request: SendChatMessageRequest) => Promise<ChatOperationResult>;

  // Worktrees
  listChatWorktrees: (projectId: string) => Promise<AvailableWorktree[]>;
  listChatBranches: (projectId: string) => Promise<string[]>;
  createChatWorktree: (projectId: string, branchName: string, baseBranch?: string) => Promise<{ success: boolean; worktreePath?: string; branch?: string; error?: string }>;

  // Images
  pickChatImages: () => Promise<ChatImageAttachment[]>;

  // Event Listeners
  onChatStreamChunk: (
    callback: (sessionId: string, chunk: string) => void
  ) => IpcListenerCleanup;
  onChatToolStart: (
    callback: (sessionId: string, tool: { name: string; input?: string }) => void
  ) => IpcListenerCleanup;
  onChatToolEnd: (
    callback: (sessionId: string) => void
  ) => IpcListenerCleanup;
  onChatComplete: (
    callback: (sessionId: string) => void
  ) => IpcListenerCleanup;
  onChatError: (
    callback: (sessionId: string, error: string) => void
  ) => IpcListenerCleanup;
}

/**
 * Create chat API instance
 */
export function createChatAPI(): ChatAPI {
  return {
    // Session Management
    createChatSession: (request) => invokeIpc('CHAT_CREATE_SESSION', request),
    deleteChatSession: (projectId, sessionId) => invokeIpc('CHAT_DELETE_SESSION', projectId, sessionId),
    listChatSessions: (projectId) => invokeIpc('CHAT_LIST_SESSIONS', projectId),
    saveChatSession: (projectId, session) => invokeIpc('CHAT_SAVE_SESSION', projectId, session),
    saveChatSessions: (projectId, sessions) => invokeIpc('CHAT_SAVE_SESSIONS', projectId, sessions),

    // Messaging
    sendChatMessage: (request) => invokeIpc('CHAT_SEND_MESSAGE', request),

    // Worktrees
    listChatWorktrees: (projectId) => invokeIpc('CHAT_LIST_WORKTREES', projectId),
    listChatBranches: (projectId) => invokeIpc('CHAT_LIST_BRANCHES', projectId),
    createChatWorktree: (projectId, branchName, baseBranch) => invokeIpc('CHAT_CREATE_WORKTREE', projectId, branchName, baseBranch),

    // Images
    pickChatImages: () => invokeIpc('CHAT_PICK_IMAGES'),

    // Event Listeners
    onChatStreamChunk: (callback) => createIpcListener('CHAT_STREAM_CHUNK', callback),
    onChatToolStart: (callback) => createIpcListener('CHAT_TOOL_START', callback),
    onChatToolEnd: (callback) => createIpcListener('CHAT_TOOL_END', callback),
    onChatComplete: (callback) => createIpcListener('CHAT_COMPLETE', callback),
    onChatError: (callback) => createIpcListener('CHAT_ERROR', callback),
  };
}
