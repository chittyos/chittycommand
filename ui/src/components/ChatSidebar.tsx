import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { api, type ChatMessage } from '../lib/api';
import { MessageSquare, X, Send, Loader2 } from 'lucide-react';

const QUICK_PROMPTS: Record<string, string[]> = {
  '/queue': ['Why this recommendation?', 'What if I defer?', 'Change the amount'],
  '/cashflow': ['Why does balance drop?', "What's my runway?", 'Revenue breakdown'],
  '/bills': ['Which can I negotiate?', "What's overdue?", 'Show sources'],
  '/disputes': ['Draft a response', 'Show evidence', 'Case timeline'],
  '/legal': ['Next deadline?', 'Any contradictions?', 'Case status'],
  '/': ['Financial summary', 'What needs attention?', 'Open issues'],
};

export function ChatSidebar() {
  const [open, setOpen] = useState(() => localStorage.getItem('chat-sidebar-open') === 'true');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const location = useLocation();

  // Keep messagesRef in sync
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Abort any in-flight stream on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // Persist open/close state
  useEffect(() => {
    localStorage.setItem('chat-sidebar-open', String(open));
  }, [open]);

  // Keyboard shortcut: Cmd+J to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || streaming) return;

    // Abort any previous in-flight stream
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg: ChatMessage = { role: 'user', content: content.trim() };
    const newMessages = [...messagesRef.current, userMsg];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);

    const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
    setMessages([...newMessages, assistantMsg]);

    try {
      const stream = api.chatStream(newMessages, { page: location.pathname }, controller.signal);
      let accumulated = '';

      for await (const chunk of stream) {
        accumulated += chunk;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: accumulated };
          return updated;
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : 'Failed to get response'}`,
        };
        return updated;
      });
    } finally {
      setStreaming(false);
    }
  }, [streaming, location.pathname]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const prompts = QUICK_PROMPTS[location.pathname] || QUICK_PROMPTS['/'];

  // Toggle button (always visible)
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-20 right-4 lg:bottom-6 lg:right-6 z-50 w-12 h-12 rounded-full bg-chitty-600 hover:bg-chitty-500 text-white shadow-lg flex items-center justify-center transition-colors"
        title="Open AI Assistant (Cmd+J)"
        aria-label="Open AI Assistant"
      >
        <MessageSquare size={20} />
      </button>
    );
  }

  return (
    <>
      {/* Mobile overlay */}
      <div
        className="fixed inset-0 bg-black/50 z-40 lg:hidden"
        onClick={() => setOpen(false)}
      />

      {/* Sidebar panel */}
      <div
        role="complementary"
        aria-label="AI Assistant"
        className="fixed inset-y-0 right-0 z-50 w-full sm:w-96 lg:w-[400px] bg-chrome-surface border-l border-chrome-border flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between h-12 px-4 border-b border-chrome-border shrink-0">
          <span className="text-sm font-semibold text-chrome-text">AI Assistant</span>
          <button
            onClick={() => setOpen(false)}
            className="p-1 text-chrome-muted hover:text-white transition-colors"
            aria-label="Close AI Assistant"
          >
            <X size={18} />
          </button>
        </div>

        {/* Messages */}
        <div role="log" aria-live="polite" className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center py-8">
              <MessageSquare size={32} className="mx-auto text-chrome-muted mb-3" />
              <p className="text-chrome-muted text-sm mb-4">Ask about your finances, actions, or data</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {prompts.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => sendMessage(prompt)}
                    className="text-xs px-3 py-1.5 rounded-full border border-chrome-border text-chrome-muted hover:text-white hover:border-chitty-600 transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  msg.role === 'user'
                    ? 'bg-chitty-600 text-white'
                    : 'bg-chrome-border/50 text-chrome-text'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
            </div>
          ))}

          {streaming && messages[messages.length - 1]?.content === '' && (
            <div className="flex justify-start">
              <div className="bg-chrome-border/50 rounded-lg px-3 py-2">
                <Loader2 size={16} className="animate-spin text-chrome-muted" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick prompts when mid-conversation */}
        {messages.length > 0 && !streaming && (
          <div className="px-4 pb-2 flex gap-1.5 overflow-x-auto scrollbar-hide">
            {prompts.slice(0, 3).map((prompt) => (
              <button
                key={prompt}
                onClick={() => sendMessage(prompt)}
                className="text-xs px-2.5 py-1 rounded-full border border-chrome-border text-chrome-muted hover:text-white hover:border-chitty-600 transition-colors shrink-0"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <form onSubmit={handleSubmit} className="p-3 border-t border-chrome-border shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              rows={1}
              className="flex-1 resize-none rounded-lg bg-chrome-bg border border-chrome-border px-3 py-2 text-sm text-chrome-text placeholder:text-chrome-muted focus:outline-none focus:border-chitty-600 max-h-24"
            />
            <button
              type="submit"
              disabled={!input.trim() || streaming}
              className="p-2 rounded-lg bg-chitty-600 text-white disabled:opacity-40 hover:bg-chitty-500 transition-colors shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="text-[10px] text-chrome-muted mt-1.5 text-center">Cmd+J to toggle</p>
        </form>
      </div>
    </>
  );
}
