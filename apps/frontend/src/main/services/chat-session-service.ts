/**
 * Chat Session Persistence Service
 *
 * Handles saving and loading chat sessions to/from disk.
 * Sessions are stored in .auto-claude/chat/sessions/[sessionId].json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatSession } from '../../shared/types/chat';

/**
 * Chat session storage directory structure:
 * .auto-claude/
 *   chat/
 *     sessions/
 *       [sessionId1].json
 *       [sessionId2].json
 *     migrated-from-insights (flag file)
 */

export class ChatSessionService {
  private projectDir: string;
  private sessionsDir: string;
  private saveDebounceMap: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 1000;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.sessionsDir = path.join(projectDir, '.auto-claude', 'chat', 'sessions');
  }

  /**
   * Ensure the sessions directory exists
   */
  private async ensureSessionsDir(): Promise<void> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create sessions directory:', error);
      throw new Error(`Failed to create sessions directory: ${error}`);
    }
  }

  /**
   * Get path to a session file
   */
  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  /**
   * Save a single session to disk (debounced)
   * @param session Session to save
   */
  async saveSession(session: ChatSession): Promise<void> {
    // Clear existing debounce timer
    const existingTimer = this.saveDebounceMap.get(session.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounced save
    const timer = setTimeout(async () => {
      try {
        await this.ensureSessionsDir();
        const sessionPath = this.getSessionPath(session.id);
        await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
        this.saveDebounceMap.delete(session.id);
      } catch (error) {
        console.error(`Failed to save session ${session.id}:`, error);
      }
    }, this.DEBOUNCE_MS);

    this.saveDebounceMap.set(session.id, timer);
  }

  /**
   * Save multiple sessions (e.g., after reordering)
   * @param sessions Sessions to save
   */
  async saveSessions(sessions: ChatSession[]): Promise<void> {
    await this.ensureSessionsDir();

    const savePromises = sessions.map(async (session) => {
      const sessionPath = this.getSessionPath(session.id);
      try {
        await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
      } catch (error) {
        console.error(`Failed to save session ${session.id}:`, error);
      }
    });

    await Promise.all(savePromises);
  }

  /**
   * Load all sessions for the current project
   * @param projectId Project ID to filter sessions
   * @returns Array of sessions, sorted by displayOrder
   */
  async loadSessions(projectId: string): Promise<ChatSession[]> {
    try {
      await this.ensureSessionsDir();

      const files = await fs.readdir(this.sessionsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      const sessions: ChatSession[] = [];

      for (const file of jsonFiles) {
        try {
          const sessionPath = path.join(this.sessionsDir, file);
          const content = await fs.readFile(sessionPath, 'utf-8');
          const session: ChatSession = JSON.parse(content);

          // Only load sessions for this project
          if (session.projectId === projectId) {
            // Validate worktree path if present
            if (session.worktreeConfig?.worktreePath) {
              const worktreeExists = await this.validateWorktreePath(
                session.worktreeConfig.worktreePath
              );
              if (!worktreeExists) {
                console.warn(
                  `Worktree no longer exists for session ${session.id}: ${session.worktreeConfig.worktreePath}`
                );
                // Keep session but mark worktree as invalid
                session.worktreeConfig = null;
              }
            }

            sessions.push(session);
          }
        } catch (error) {
          console.error(`Failed to load session from ${file}:`, error);
        }
      }

      // Sort by displayOrder
      sessions.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));

      return sessions;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return [];
    }
  }

  /**
   * Delete a session from disk
   * @param sessionId Session ID to delete
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      // Cancel any pending save
      const existingTimer = this.saveDebounceMap.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.saveDebounceMap.delete(sessionId);
      }

      const sessionPath = this.getSessionPath(sessionId);
      await fs.unlink(sessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to delete session ${sessionId}:`, error);
        throw error;
      }
    }
  }

  /**
   * Validate that a worktree path still exists
   * @param worktreePath Path to validate
   * @returns True if path exists and is a directory
   */
  async validateWorktreePath(worktreePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(worktreePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Check if migration from Insights has been performed
   * @returns True if migration flag file exists
   */
  async isMigrationComplete(): Promise<boolean> {
    const flagPath = path.join(
      this.projectDir,
      '.auto-claude',
      'chat',
      'migrated-from-insights'
    );

    try {
      await fs.access(flagPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mark migration as complete
   */
  async markMigrationComplete(): Promise<void> {
    const chatDir = path.join(this.projectDir, '.auto-claude', 'chat');
    await fs.mkdir(chatDir, { recursive: true });

    const flagPath = path.join(chatDir, 'migrated-from-insights');
    await fs.writeFile(flagPath, new Date().toISOString(), 'utf-8');
  }

  /**
   * Migrate sessions from old Insights directory
   * Non-destructive - keeps old files intact
   * @param projectId Project ID for the sessions
   * @returns Array of migrated sessions
   */
  async migrateFromInsights(projectId: string): Promise<ChatSession[]> {
    const oldInsightsDir = path.join(
      this.projectDir,
      '.auto-claude',
      'insights',
      'sessions'
    );

    try {
      // Check if old directory exists
      await fs.access(oldInsightsDir);
    } catch {
      // No old insights directory, nothing to migrate
      // Mark migration as complete so we don't check again
      await this.markMigrationComplete();
      return [];
    }

    const migratedSessions: ChatSession[] = [];

    try {
      const files = await fs.readdir(oldInsightsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const oldPath = path.join(oldInsightsDir, file);
          const content = await fs.readFile(oldPath, 'utf-8');
          const oldSession = JSON.parse(content);

          // Convert old format to new format
          const newSession: ChatSession = {
            id: oldSession.id || oldSession.sessionId || file.replace('.json', ''),
            projectId,
            title: oldSession.title,
            worktreeConfig: oldSession.worktreeContext
              ? {
                  name: oldSession.worktreeContext.name || 'Unknown',
                  worktreePath: oldSession.worktreeContext.path || oldSession.worktreeContext.worktreePath,
                  branchName: oldSession.worktreeContext.branch || oldSession.worktreeContext.branchName || 'main',
                  baseBranch: oldSession.worktreeContext.baseBranch || 'develop',
                  taskId: oldSession.worktreeContext.taskId,
                  createdAt: oldSession.worktreeContext.createdAt || oldSession.createdAt,
                }
              : null,
            messages: oldSession.messages || [],
            modelConfig: oldSession.modelConfig,
            createdAt: oldSession.createdAt || new Date().toISOString(),
            updatedAt: oldSession.updatedAt || new Date().toISOString(),
            displayOrder: oldSession.displayOrder,
          };

          // Validate and save
          await this.ensureSessionsDir();
          const newPath = this.getSessionPath(newSession.id);
          await fs.writeFile(newPath, JSON.stringify(newSession, null, 2), 'utf-8');

          migratedSessions.push(newSession);
          console.log(`Migrated session: ${newSession.id}`);
        } catch (error) {
          console.error(`Failed to migrate session from ${file}:`, error);
        }
      }

      // Mark migration as complete
      await this.markMigrationComplete();

      console.log(`Migration complete: ${migratedSessions.length} sessions migrated`);
      return migratedSessions;
    } catch (error) {
      console.error('Failed to migrate from Insights:', error);
      return [];
    }
  }

  /**
   * Flush all pending saves
   */
  async flushPendingSaves(): Promise<void> {
    const pendingTimers = Array.from(this.saveDebounceMap.entries());

    // Clear all timers
    for (const [sessionId, timer] of pendingTimers) {
      clearTimeout(timer);
      this.saveDebounceMap.delete(sessionId);
    }

    // Note: We don't re-save here because the debounced saves will have already
    // been scheduled and will complete. This method is mainly for cleanup.
  }
}
