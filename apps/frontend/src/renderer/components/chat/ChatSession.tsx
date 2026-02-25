/**
 * ChatSession Component
 *
 * Displays a single chat session with messages, input, and streaming support
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Send,
  Loader2,
  User,
  Bot,
  AlertCircle,
  Search,
  FileText,
  FolderSearch,
  ImagePlus,
  X,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import type { ChatSession as ChatSessionType, ChatMessage, ChatModelConfig, ChatStatus, ChatImageAttachment } from '@shared/types/chat';

// Safe link component with validation
const createSafeLink = (opensInNewWindowText: string) => {
  return function SafeLink({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    const isValidUrl = href && (
      href.startsWith('http://') ||
      href.startsWith('https://') ||
      href.startsWith('/') ||
      href.startsWith('#')
    );

    if (!isValidUrl) {
      return <span className="text-muted-foreground">{children}</span>;
    }

    const isExternal = href?.startsWith('http://') || href?.startsWith('https://');

    return (
      <a
        href={href}
        {...props}
        {...(isExternal && {
          target: '_blank',
          rel: 'noopener noreferrer',
        })}
        className="text-primary hover:underline"
      >
        {children}
        {isExternal && <span className="sr-only"> {opensInNewWindowText}</span>}
      </a>
    );
  };
};

interface ChatSessionProps {
  session: ChatSessionType;
  isActive: boolean;
  status: ChatStatus;
  streamingContent: string;
  currentTool?: { name: string; input?: string };
  error?: string | null;
  onSendMessage: (message: string, images?: ChatImageAttachment[]) => void;
  onUpdateModel?: (config: ChatModelConfig) => void;
}

export function ChatSession({
  session,
  isActive,
  status,
  streamingContent,
  currentTool,
  error,
  onSendMessage,
}: ChatSessionProps) {
  const { t } = useTranslation('common');
  const [inputValue, setInputValue] = useState('');
  const [pendingImages, setPendingImages] = useState<ChatImageAttachment[]>([]);
  const [isUserAtBottom, setIsUserAtBottom] = useState(true);
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const SCROLL_BOTTOM_THRESHOLD = 100;

  // Create markdown components with translated accessibility text
  const markdownComponents = useMemo(() => ({
    a: createSafeLink(t('accessibility.opensInNewWindow')),
  }), [t]);

  // Check if user is near bottom
  const checkIfAtBottom = useCallback((viewport: HTMLElement) => {
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    return scrollHeight - scrollTop - clientHeight <= SCROLL_BOTTOM_THRESHOLD;
  }, []);

  // Handle scroll events
  const handleScroll = useCallback(() => {
    if (viewportEl) {
      setIsUserAtBottom(checkIfAtBottom(viewportEl));
    }
  }, [viewportEl, checkIfAtBottom]);

  // Set up scroll listener
  useEffect(() => {
    if (viewportEl) {
      setIsUserAtBottom(checkIfAtBottom(viewportEl));
      viewportEl.addEventListener('scroll', handleScroll, { passive: true });
      return () => viewportEl.removeEventListener('scroll', handleScroll);
    }
  }, [viewportEl, handleScroll, checkIfAtBottom]);

  // Smart auto-scroll
  useEffect(() => {
    if (isUserAtBottom && viewportEl) {
      viewportEl.scrollTop = viewportEl.scrollHeight;
    }
  }, [isUserAtBottom, viewportEl, streamingContent, session.messages]);

  // Focus textarea when active
  useEffect(() => {
    if (isActive) {
      textareaRef.current?.focus();
    }
  }, [isActive]);

  const handleSend = () => {
    const message = inputValue.trim();
    if ((!message && pendingImages.length === 0) || status === 'streaming' || status === 'tool_running') return;

    const images = pendingImages.length > 0 ? [...pendingImages] : undefined;
    setInputValue('');
    setPendingImages([]);
    onSendMessage(message || '(image)', images);
    setIsUserAtBottom(true);
  };

  const handlePickImages = async () => {
    try {
      const images = await window.electronAPI.pickChatImages();
      if (images.length > 0) {
        setPendingImages((prev) => [...prev, ...images]);
      }
    } catch (error) {
      console.error('Failed to pick images:', error);
    }
  };

  const handleRemovePendingImage = (imageId: string) => {
    setPendingImages((prev) => prev.filter((img) => img.id !== imageId));
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems: DataTransferItem[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        imageItems.push(item);
      }
    }

    if (imageItems.length === 0) return;

    e.preventDefault();

    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Extract base64 data (remove data:image/png;base64, prefix)
        const base64Data = result.split(',')[1];
        const mediaType = blob.type || 'image/png';

        const attachment: ChatImageAttachment = {
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename: `pasted-image.${mediaType.split('/')[1]}`,
          mediaType,
          data: base64Data,
        };

        setPendingImages((prev) => [...prev, attachment]);
      };
      reader.readAsDataURL(blob);
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isLoading = status === 'streaming' || status === 'tool_running';
  const messages = session.messages || [];

  return (
    <div className="flex flex-1 flex-col h-full">
      {/* Messages */}
      <ScrollArea className="flex-1 px-6 py-4" onViewportRef={setViewportEl}>
        {messages.length === 0 && !streamingContent ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <Bot className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-lg font-medium text-foreground">
              Start a Conversation
            </h3>
            <p className="max-w-md text-sm text-muted-foreground">
              {session.worktreeConfig
                ? `Ask questions about the ${session.worktreeConfig.branchName} branch`
                : 'Ask questions about your codebase'
              }
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                markdownComponents={markdownComponents}
              />
            ))}

            {/* Streaming message */}
            {(streamingContent || currentTool) && (
              <div className="flex gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1">
                  <div className="mb-1 text-sm font-medium text-foreground">
                    Assistant
                  </div>
                  {streamingContent && (
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {streamingContent}
                      </ReactMarkdown>
                    </div>
                  )}
                  {currentTool && (
                    <ToolIndicator name={currentTool.name} input={currentTool.input} />
                  )}
                </div>
              </div>
            )}

            {/* Error message */}
            {status === 'error' && error && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-border p-4">
        {/* Pending image previews */}
        {pendingImages.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {pendingImages.map((img) => (
              <div key={img.id} className="group relative">
                <img
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt={img.filename}
                  className="h-16 w-16 rounded-md border border-border object-cover"
                />
                <button
                  type="button"
                  onClick={() => handleRemovePendingImage(img.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                session.worktreeConfig
                  ? `Ask about ${session.worktreeConfig.branchName}...`
                  : 'Ask about your codebase...'
              }
              className="min-h-[80px] resize-none"
              disabled={isLoading}
            />
          </div>
          <div className="flex flex-col justify-end gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={handlePickImages}
              disabled={isLoading}
              title={t('chat.attachImage')}
            >
              <ImagePlus className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleSend}
              disabled={(!inputValue.trim() && pendingImages.length === 0) || isLoading}
              size="icon"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t('chat.inputHint')}
        </p>
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  markdownComponents: Components;
}

function MessageBubble({ message, markdownComponents }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className="flex gap-3">
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-muted' : 'bg-primary/10'
        )}
      >
        {isUser ? (
          <User className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Bot className="h-4 w-4 text-primary" />
        )}
      </div>
      <div className="flex-1 space-y-2">
        <div className="text-sm font-medium text-foreground">
          {isUser ? 'You' : 'Assistant'}
        </div>

        {/* Image attachments */}
        {isUser && message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {message.images.map((img) => (
              <img
                key={img.id}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.filename}
                className="max-h-48 max-w-xs rounded-md border border-border object-contain"
              />
            ))}
          </div>
        )}

        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {message.content}
          </ReactMarkdown>
        </div>

        {/* Tool usage history */}
        {!isUser && message.toolsUsed && message.toolsUsed.length > 0 && (
          <ToolUsageHistory tools={message.toolsUsed} />
        )}
      </div>
    </div>
  );
}

interface ToolUsageHistoryProps {
  tools: Array<{
    name: string;
    input?: string;
    timestamp: string;
  }>;
}

function ToolUsageHistory({ tools }: ToolUsageHistoryProps) {
  const [expanded, setExpanded] = useState(false);

  if (tools.length === 0) return null;

  const toolCounts = tools.reduce((acc, tool) => {
    acc[tool.name] = (acc[tool.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const getToolIcon = (toolName: string) => {
    switch (toolName) {
      case 'Read':
        return FileText;
      case 'Glob':
        return FolderSearch;
      case 'Grep':
        return Search;
      default:
        return FileText;
    }
  };

  const getToolColor = (toolName: string) => {
    switch (toolName) {
      case 'Read':
        return 'text-blue-500';
      case 'Glob':
        return 'text-amber-500';
      case 'Grep':
        return 'text-green-500';
      default:
        return 'text-muted-foreground';
    }
  };

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        type="button"
      >
        <span className="flex items-center gap-1">
          {Object.entries(toolCounts).map(([name, count]) => {
            const Icon = getToolIcon(name);
            return (
              <span key={name} className={cn('flex items-center gap-0.5', getToolColor(name))}>
                <Icon className="h-3 w-3" />
                <span>{count}</span>
              </span>
            );
          })}
        </span>
        <span>{tools.length} tool{tools.length !== 1 ? 's' : ''} used</span>
        <span className="text-[10px]">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1 rounded-md border border-border bg-muted/30 p-2">
          {tools.map((tool, index) => {
            const Icon = getToolIcon(tool.name);
            return (
              <div
                key={`${tool.name}-${index}`}
                className="flex items-center gap-2 text-xs"
              >
                <Icon className={cn('h-3 w-3 shrink-0', getToolColor(tool.name))} />
                <span className="font-medium">{tool.name}</span>
                {tool.input && (
                  <span className="text-muted-foreground truncate max-w-[250px]">
                    {tool.input}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ToolIndicatorProps {
  name: string;
  input?: string;
}

function ToolIndicator({ name, input }: ToolIndicatorProps) {
  const getToolInfo = (toolName: string) => {
    switch (toolName) {
      case 'Read':
        return {
          icon: FileText,
          label: 'Reading file',
          color: 'text-blue-500 bg-blue-500/10'
        };
      case 'Glob':
        return {
          icon: FolderSearch,
          label: 'Searching files',
          color: 'text-amber-500 bg-amber-500/10'
        };
      case 'Grep':
        return {
          icon: Search,
          label: 'Searching code',
          color: 'text-green-500 bg-green-500/10'
        };
      default:
        return {
          icon: Loader2,
          label: toolName,
          color: 'text-primary bg-primary/10'
        };
    }
  };

  const { icon: Icon, label, color } = getToolInfo(name);

  return (
    <div className={cn(
      'mt-2 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
      color
    )}>
      <Icon className="h-4 w-4 animate-pulse" />
      <span className="font-medium">{label}</span>
      {input && (
        <span className="text-muted-foreground truncate max-w-[300px]">
          {input}
        </span>
      )}
    </div>
  );
}
