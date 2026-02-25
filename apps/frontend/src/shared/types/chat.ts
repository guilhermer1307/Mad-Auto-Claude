/**
 * Chat system type definitions for multi-worktree chat interface
 */

/**
 * Configuration for a chat session attached to a worktree
 */
export interface ChatWorktreeConfig {
  /** Display name of the worktree */
  name: string;
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Current branch name */
  branchName: string;
  /** Base branch this worktree branched from */
  baseBranch: string;
  /** Associated task ID if this is a task worktree */
  taskId?: string;
  /** ISO timestamp when worktree was created */
  createdAt: string;
}

/**
 * Model configuration for a chat session
 */
export interface ChatModelConfig {
  /** API profile ID to use */
  profileId: string;
  /** Model type (haiku, sonnet, opus, or full model ID) */
  model: string;
  /** Thinking level for extended reasoning */
  thinkingLevel: 'low' | 'medium' | 'high';
}

/**
 * Tool usage information for a chat message
 */
export interface ChatToolUsage {
  /** Tool name (e.g., 'Read', 'Grep', 'Glob') */
  name: string;
  /** Brief description of what the tool did */
  input?: string;
  /** ISO timestamp when tool was executed */
  timestamp: string;
}

/**
 * An image attachment in a chat message
 */
export interface ChatImageAttachment {
  /** Unique attachment ID */
  id: string;
  /** Original filename */
  filename: string;
  /** MIME type (image/png, image/jpeg, image/gif, image/webp) */
  mediaType: string;
  /** Base64-encoded image data */
  data: string;
  /** Image dimensions (for display) */
  width?: number;
  height?: number;
}

/**
 * A single chat message in a session
 */
export interface ChatMessage {
  /** Unique message ID */
  id: string;
  /** Message role (user or assistant) */
  role: 'user' | 'assistant';
  /** Message content (markdown formatted) */
  content: string;
  /** ISO timestamp when message was created */
  timestamp: string;
  /** Tools used during this message (for assistant messages) */
  toolsUsed?: ChatToolUsage[];
  /** Image attachments (for user messages) */
  images?: ChatImageAttachment[];
}

/**
 * Status of a chat session
 */
export type ChatStatus =
  | 'idle'           // Ready for input
  | 'streaming'      // AI is responding
  | 'tool_running'   // AI is executing a tool
  | 'error';         // Error occurred

/**
 * A chat session instance
 */
export interface ChatSession {
  /** Unique session ID */
  id: string;
  /** Project ID this session belongs to */
  projectId: string;
  /** User-provided session title (optional) */
  title?: string;
  /** Worktree configuration (null = main project, not attached to worktree) */
  worktreeConfig?: ChatWorktreeConfig | null;
  /** Message history */
  messages: ChatMessage[];
  /** Model configuration (uses project default if not specified) */
  modelConfig?: ChatModelConfig;
  /** ISO timestamp when session was created */
  createdAt: string;
  /** ISO timestamp when session was last updated */
  updatedAt: string;
  /** Display order for tab positioning */
  displayOrder?: number;
}

/**
 * Streaming state for a chat session
 */
export interface ChatStreamingState {
  /** Accumulated streaming content */
  content: string;
  /** Tools used during streaming */
  toolsUsed: ChatToolUsage[];
}

/**
 * IPC result type for chat operations
 */
export interface ChatOperationResult {
  success: boolean;
  error?: string;
  sessionId?: string;
}

/**
 * Request to send a chat message
 */
export interface SendChatMessageRequest {
  projectId: string;
  sessionId: string;
  message: string;
  modelConfig?: ChatModelConfig;
  worktreePath?: string;
  /** Image attachments to include with the message */
  images?: ChatImageAttachment[];
}

/**
 * Request to create a new chat session
 */
export interface CreateChatSessionRequest {
  projectId: string;
  worktreeConfig?: ChatWorktreeConfig | null;
  title?: string;
  modelConfig?: ChatModelConfig;
}

/**
 * Available worktrees for selection
 */
export interface AvailableWorktree {
  /** Worktree name */
  name: string;
  /** Absolute path */
  path: string;
  /** Current branch */
  branch: string;
  /** Base branch */
  baseBranch: string;
  /** Type of worktree */
  type: 'task' | 'terminal' | 'manual';
  /** Associated task ID if type=task */
  taskId?: string;
}
