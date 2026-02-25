/**
 * Chat IPC Handlers
 *
 * Handles all IPC communication for the multi-worktree chat system
 */

import { ipcMain, dialog, type IpcMainInvokeEvent, type BrowserWindow } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { ChatSessionService } from '../services/chat-session-service';
import type {
  ChatSession,
  CreateChatSessionRequest,
  SendChatMessageRequest,
  ChatOperationResult,
  ChatImageAttachment,
  AvailableWorktree,
} from '../../shared/types/chat';
import { projectStore } from '../project-store';

// Service instances per project
const sessionServices = new Map<string, ChatSessionService>();

/**
 * Get or create session service for a project
 */
function getSessionService(projectId: string): ChatSessionService {
  if (!sessionServices.has(projectId)) {
    const project = projectStore.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    sessionServices.set(projectId, new ChatSessionService(project.path));
  }
  return sessionServices.get(projectId)!;
}

/**
 * Register all chat-related IPC handlers
 */
export function registerChatHandlers(): void {
  // ===== Session Management =====

  /**
   * Create a new chat session
   */
  ipcMain.handle(
    'CHAT_CREATE_SESSION',
    async (
      _event: IpcMainInvokeEvent,
      request: CreateChatSessionRequest
    ): Promise<ChatOperationResult> => {
      try {
        const service = getSessionService(request.projectId);

        // Session will be created in the renderer store
        // We just need to ensure the sessions directory exists
        const project = projectStore.getProject(request.projectId);
        if (!project) {
          throw new Error(`Project not found: ${request.projectId}`);
        }
        await fs.mkdir(
          path.join(project.path, '.auto-claude', 'chat', 'sessions'),
          { recursive: true }
        );

        return { success: true };
      } catch (error) {
        console.error('Failed to create session:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  /**
   * Delete a chat session
   */
  ipcMain.handle(
    'CHAT_DELETE_SESSION',
    async (
      _event: IpcMainInvokeEvent,
      projectId: string,
      sessionId: string
    ): Promise<ChatOperationResult> => {
      try {
        const service = getSessionService(projectId);
        await service.deleteSession(sessionId);
        return { success: true };
      } catch (error) {
        console.error('Failed to delete session:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  /**
   * Load all sessions for a project
   */
  ipcMain.handle(
    'CHAT_LIST_SESSIONS',
    async (_event: IpcMainInvokeEvent, projectId: string): Promise<ChatSession[]> => {
      try {
        const service = getSessionService(projectId);

        // Check if migration is needed
        const migrationComplete = await service.isMigrationComplete();
        if (!migrationComplete) {
          console.log('Migrating sessions from Insights...');
          const migratedSessions = await service.migrateFromInsights(projectId);
          if (migratedSessions.length > 0) {
            console.log(`Migrated ${migratedSessions.length} sessions`);
          }
        }

        return await service.loadSessions(projectId);
      } catch (error) {
        console.error('Failed to list sessions:', error);
        return [];
      }
    }
  );

  /**
   * Save a session to disk
   */
  ipcMain.handle(
    'CHAT_SAVE_SESSION',
    async (
      _event: IpcMainInvokeEvent,
      projectId: string,
      session: ChatSession
    ): Promise<ChatOperationResult> => {
      try {
        const service = getSessionService(projectId);
        await service.saveSession(session);
        return { success: true };
      } catch (error) {
        console.error('Failed to save session:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  /**
   * Save multiple sessions (e.g., after reordering)
   */
  ipcMain.handle(
    'CHAT_SAVE_SESSIONS',
    async (
      _event: IpcMainInvokeEvent,
      projectId: string,
      sessions: ChatSession[]
    ): Promise<ChatOperationResult> => {
      try {
        const service = getSessionService(projectId);
        await service.saveSessions(sessions);
        return { success: true };
      } catch (error) {
        console.error('Failed to save sessions:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  // ===== Message Handling =====

  /**
   * Send a message and stream the response
   */
  ipcMain.handle(
    'CHAT_SEND_MESSAGE',
    async (
      event: IpcMainInvokeEvent,
      request: SendChatMessageRequest
    ): Promise<ChatOperationResult> => {
      try {
        const project = projectStore.getProject(request.projectId);
        if (!project) {
          throw new Error(`Project not found: ${request.projectId}`);
        }
        const projectPath = project.path;

        // Get session to load conversation history
        const service = getSessionService(request.projectId);
        const sessions = await service.loadSessions(request.projectId);
        const session = sessions.find((s) => s.id === request.sessionId);

        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }

        // Build history for Python runner
        // For messages with images, construct multi-part content blocks
        const history = session.messages.map((msg) => {
          if (msg.role === 'user' && msg.images && msg.images.length > 0) {
            // Multi-part message with images
            const content: Array<Record<string, unknown>> = [];
            for (const img of msg.images) {
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.mediaType,
                  data: img.data,
                },
              });
            }
            content.push({ type: 'text', text: msg.content });
            return { role: msg.role, content };
          }
          return { role: msg.role, content: msg.content };
        });

        // Add the new user message (with images if present)
        if (request.images && request.images.length > 0) {
          const content: Array<Record<string, unknown>> = [];
          for (const img of request.images) {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mediaType,
                data: img.data,
              },
            });
          }
          content.push({ type: 'text', text: request.message });
          history.push({ role: 'user', content });
        } else {
          history.push({ role: 'user', content: request.message });
        }

        // Write history to temp file for Python
        const historyFile = path.join(
          projectPath,
          '.auto-claude',
          'chat',
          `history-${request.sessionId}.json`
        );
        await fs.writeFile(historyFile, JSON.stringify(history), 'utf-8');

        // Build Python command
        const pythonArgs = [
          path.join(projectPath, 'apps', 'backend', 'runners', 'insights_runner.py'),
          '--project-dir',
          projectPath,
          '--message',
          request.message,
          '--history-file',
          historyFile,
        ];

        // Add model config if provided
        if (request.modelConfig) {
          pythonArgs.push('--model', request.modelConfig.model);
          pythonArgs.push('--thinking-level', request.modelConfig.thinkingLevel);
        }

        // Add worktree path if provided
        if (request.worktreePath) {
          pythonArgs.push('--worktree-path', request.worktreePath);
        }

        // Spawn Python process
        const pythonProcess = spawn('python', pythonArgs, {
          cwd: path.join(projectPath, 'apps', 'backend'),
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1', // Disable Python buffering for real-time streaming
          },
        });

        let buffer = '';

        // Stream stdout
        pythonProcess.stdout.on('data', (data: Buffer) => {
          buffer += data.toString();

          // Process complete lines
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            // Check for special markers
            if (line.startsWith('__TOOL_START__:')) {
              const toolData = JSON.parse(line.substring(15));
              event.sender.send('CHAT_TOOL_START', request.sessionId, toolData);
            } else if (line.startsWith('__TOOL_END__:')) {
              const toolData = JSON.parse(line.substring(13));
              event.sender.send('CHAT_TOOL_END', request.sessionId, toolData);
            } else if (line.startsWith('__TASK_SUGGESTION__:')) {
              // Task suggestion from AI
              const suggestionData = JSON.parse(line.substring(20));
              event.sender.send('CHAT_TASK_SUGGESTION', request.sessionId, suggestionData);
            } else {
              // Regular content - stream to renderer
              event.sender.send('CHAT_STREAM_CHUNK', request.sessionId, line + '\n');
            }
          }
        });

        // Handle stderr
        pythonProcess.stderr.on('data', (data: Buffer) => {
          console.error('Python stderr:', data.toString());
        });

        // Handle process completion
        pythonProcess.on('close', (code: number) => {
          // Send any remaining buffer content
          if (buffer.trim()) {
            event.sender.send('CHAT_STREAM_CHUNK', request.sessionId, buffer);
          }

          // Cleanup temp history file
          fs.unlink(historyFile).catch(() => {
            // Ignore errors
          });

          if (code === 0) {
            event.sender.send('CHAT_COMPLETE', request.sessionId);
          } else {
            event.sender.send(
              'CHAT_ERROR',
              request.sessionId,
              `Python process exited with code ${code}`
            );
          }
        });

        pythonProcess.on('error', (error: Error) => {
          event.sender.send('CHAT_ERROR', request.sessionId, error.message);
        });

        return { success: true, sessionId: request.sessionId };
      } catch (error) {
        console.error('Failed to send message:', error);
        event.sender.send(
          'CHAT_ERROR',
          request.sessionId,
          error instanceof Error ? error.message : 'Unknown error'
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  // ===== Image Picker =====

  /**
   * Open file dialog to pick images for chat
   */
  ipcMain.handle(
    'CHAT_PICK_IMAGES',
    async (_event: IpcMainInvokeEvent): Promise<ChatImageAttachment[]> => {
      try {
        const { BrowserWindow: BW } = await import('electron');
        const focusedWindow = BW.getFocusedWindow();

        const result = await dialog.showOpenDialog(focusedWindow!, {
          title: 'Select Images',
          filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
          ],
          properties: ['openFile', 'multiSelections'],
        });

        if (result.canceled || result.filePaths.length === 0) {
          return [];
        }

        const attachments: ChatImageAttachment[] = [];

        for (const filePath of result.filePaths) {
          try {
            const fileBuffer = await fs.readFile(filePath);
            const base64Data = fileBuffer.toString('base64');
            const ext = path.extname(filePath).toLowerCase().slice(1);
            const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
            const filename = path.basename(filePath);

            attachments.push({
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              filename,
              mediaType,
              data: base64Data,
            });
          } catch (error) {
            console.error(`Failed to read image ${filePath}:`, error);
          }
        }

        return attachments;
      } catch (error) {
        console.error('Failed to pick images:', error);
        return [];
      }
    }
  );

  // ===== Worktree Management =====

  /**
   * Get available worktrees for selection
   */
  ipcMain.handle(
    'CHAT_LIST_WORKTREES',
    async (_event: IpcMainInvokeEvent, projectId: string): Promise<AvailableWorktree[]> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          throw new Error(`Project not found: ${projectId}`);
        }
        const projectPath = project.path;

        const worktrees: AvailableWorktree[] = [];

        // Check for task worktrees
        const taskWorktreesDir = path.join(projectPath, '.auto-claude', 'worktrees', 'tasks');
        try {
          const taskDirs = await fs.readdir(taskWorktreesDir);
          for (const taskDir of taskDirs) {
            const worktreePath = path.join(taskWorktreesDir, taskDir);
            const stats = await fs.stat(worktreePath);

            if (stats.isDirectory()) {
              // Extract task ID
              const taskId = taskDir.split('-')[0];

              // Get branch info
              const branch = await getWorktreeBranch(worktreePath);

              worktrees.push({
                name: taskDir,
                path: worktreePath,
                branch: branch || 'unknown',
                baseBranch: 'develop', // Default, could be read from config
                type: 'task',
                taskId,
              });
            }
          }
        } catch {
          // Task worktrees directory doesn't exist
        }

        // Check for terminal worktrees
        const terminalWorktreesDir = path.join(
          projectPath,
          '.auto-claude',
          'worktrees',
          'terminal'
        );
        try {
          const terminalDirs = await fs.readdir(terminalWorktreesDir);
          for (const terminalDir of terminalDirs) {
            const worktreePath = path.join(terminalWorktreesDir, terminalDir);
            const stats = await fs.stat(worktreePath);

            if (stats.isDirectory()) {
              const branch = await getWorktreeBranch(worktreePath);

              worktrees.push({
                name: terminalDir,
                path: worktreePath,
                branch: branch || 'unknown',
                baseBranch: 'develop',
                type: 'terminal',
              });
            }
          }
        } catch {
          // Terminal worktrees directory doesn't exist
        }

        return worktrees;
      } catch (error) {
        console.error('Failed to list worktrees:', error);
        return [];
      }
    }
  );

  /**
   * Create a worktree for a chat session
   * Resolves projectId to projectPath internally
   */
  ipcMain.handle(
    'CHAT_CREATE_WORKTREE',
    async (
      _event: IpcMainInvokeEvent,
      projectId: string,
      branchName: string,
      baseBranch?: string
    ): Promise<{ success: boolean; worktreePath?: string; branch?: string; error?: string }> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: `Project not found: ${projectId}` };
        }
        const projectPath = project.path;

        // Validate branch name
        const GIT_BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
        if (!GIT_BRANCH_REGEX.test(branchName)) {
          return { success: false, error: 'Invalid branch name. Use alphanumeric characters, dots, slashes, dashes, and underscores.' };
        }

        // Sanitize name for filesystem (replace slashes with dashes)
        const worktreeName = branchName.replace(/\//g, '-').toLowerCase();

        // Build worktree path under .auto-claude/worktrees/terminal/
        const worktreeDir = path.join(projectPath, '.auto-claude', 'worktrees', 'terminal');
        const worktreePath = path.join(worktreeDir, worktreeName);

        if (existsSync(worktreePath)) {
          return { success: false, error: `Worktree '${worktreeName}' already exists.` };
        }

        mkdirSync(worktreeDir, { recursive: true });

        // Resolve base branch (default to project's main branch)
        const effectiveBaseBranch = baseBranch || 'develop';

        // Fetch latest from remote
        const execFileAsync = promisify(execFile);
        try {
          await execFileAsync('git', ['fetch', 'origin', effectiveBaseBranch], {
            cwd: projectPath,
            encoding: 'utf-8',
            timeout: 30000,
          });
        } catch {
          // Could not fetch, continue with local
        }

        // Check if remote ref exists, prefer it
        let baseRef = effectiveBaseBranch;
        try {
          await execFileAsync('git', ['rev-parse', '--verify', `origin/${effectiveBaseBranch}`], {
            cwd: projectPath,
            encoding: 'utf-8',
            timeout: 10000,
          });
          baseRef = `origin/${effectiveBaseBranch}`;
        } catch {
          // Remote ref not found, use local
        }

        // Create worktree with new branch
        await execFileAsync('git', ['worktree', 'add', '-b', branchName, '--no-track', worktreePath, baseRef], {
          cwd: projectPath,
          encoding: 'utf-8',
          timeout: 60000,
        });

        console.log(`[ChatWorktree] Created worktree: ${worktreePath} on branch ${branchName} from ${baseRef}`);

        return {
          success: true,
          worktreePath,
          branch: branchName,
        };
      } catch (error) {
        console.error('Failed to create chat worktree:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  /**
   * Get available branches for worktree creation
   */
  ipcMain.handle(
    'CHAT_LIST_BRANCHES',
    async (_event: IpcMainInvokeEvent, projectId: string): Promise<string[]> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          throw new Error(`Project not found: ${projectId}`);
        }

        const { execSync } = await import('node:child_process');
        const branches = execSync('git branch -a --format="%(refname:short)"', {
          cwd: project.path,
          encoding: 'utf-8',
        })
          .trim()
          .split('\n')
          .map((b) => b.trim())
          .filter((b) => b && !b.startsWith('origin/HEAD'))
          .map((b) => b.replace(/^origin\//, ''))
          .filter((b, idx, arr) => arr.indexOf(b) === idx); // Remove duplicates

        return branches;
      } catch (error) {
        console.error('Failed to list branches:', error);
        return ['develop', 'main', 'master']; // Fallback to common branches
      }
    }
  );
}

/**
 * Get the current branch name for a worktree
 */
async function getWorktreeBranch(worktreePath: string): Promise<string | null> {
  try {
    const { execSync } = await import('node:child_process');
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();
    return branch;
  } catch {
    return null;
  }
}
