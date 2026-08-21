'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';

interface PendingAction {
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
  pendingAction?: PendingAction | null;
  /** Set once the operator has decided, so the card stops offering buttons. */
  actionOutcome?: 'applied' | 'declined' | 'failed';
  outcomeDetail?: string;
}

const SUGGESTIONS = [
  'How are things going?',
  "What's broken right now?",
  'How is domain warm-up progressing?',
  'What am I spending on AI this month?',
];

export function Assistant() {
  const router = useRouter();
  const { status } = useSession();
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    setInput('');
    setBusy(true);

    // Only prose goes back as history — tool traffic is rebuilt server-side.
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((current) => [...current, { role: 'user', content: question }]);

    try {
      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, history }),
      });
      const json = await response.json();

      setMessages((current) => [
        ...current,
        json.ok
          ? {
              role: 'assistant',
              content: json.data.reply,
              toolsUsed: json.data.toolsUsed,
              pendingAction: json.data.pendingAction,
            }
          : { role: 'assistant', content: json.error ?? 'Something went wrong.' },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: 'Could not reach the server.' },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(index: number, action: PendingAction) {
    setConfirming(true);
    try {
      const response = await fetch('/api/assistant/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName: action.toolName, input: action.input }),
      });
      const json = await response.json();
      const ok = json.ok && json.data.applied;

      setMessages((current) =>
        current.map((m, i) =>
          i === index
            ? {
                ...m,
                actionOutcome: ok ? 'applied' : 'failed',
                outcomeDetail: ok ? undefined : (json.data?.error ?? json.error),
              }
            : m,
        ),
      );

      if (ok) router.refresh();
    } catch {
      setMessages((current) =>
        current.map((m, i) =>
          i === index
            ? { ...m, actionOutcome: 'failed', outcomeDetail: 'Could not reach the server.' }
            : m,
        ),
      );
    } finally {
      setConfirming(false);
    }
  }

  function decline(index: number) {
    setMessages((current) =>
      current.map((m, i) => (i === index ? { ...m, actionOutcome: 'declined' } : m)),
    );
  }

  // Mounted globally, so it hides itself rather than appearing over a sign-in
  // form. The route check matters independently of the session: an existing
  // cookie makes /login "authenticated", and a chat panel does not belong there.
  if (status !== 'authenticated') return null;
  if (pathname === '/login') return null;

  if (!isOpen) {
    return (
      <button
        className="asst-launch"
        onClick={() => setIsOpen(true)}
        aria-label="Open assistant"
        title="Ask the assistant"
      >
        <span aria-hidden="true">✦</span>
      </button>
    );
  }

  return (
    <div className="asst" role="dialog" aria-label="Dashboard assistant">
      <div className="asst-head">
        <span className="asst-mark" aria-hidden="true">
          ✦
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="asst-title">Assistant</div>
          <div className="asst-sub">Asks before it changes anything</div>
        </div>
        {messages.length > 0 && (
          <button className="ctrl sm ghost" onClick={() => setMessages([])} title="Clear">
            Clear
          </button>
        )}
        <button className="ctrl sm ghost" onClick={() => setIsOpen(false)} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="asst-body" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="asst-empty">
            <p style={{ marginTop: 0 }}>
              Ask about anything in the system, or tell me to change it. I can look things up on my
              own — changes wait for your confirmation.
            </p>
            <div className="asst-chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="asst-chip" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
            <p className="asst-note">
              I can&apos;t send or approve emails — that stays with you, by design.
            </p>
          </div>
        )}

        {messages.map((message, index) => (
          <div key={index} className={`asst-msg ${message.role}`}>
            <div className="asst-bubble">{message.content}</div>

            {message.toolsUsed && message.toolsUsed.length > 0 && (
              <div className="asst-tools">
                checked {[...new Set(message.toolsUsed)].map((t) => t.replace(/_/g, ' ')).join(', ')}
              </div>
            )}

            {message.pendingAction && !message.actionOutcome && (
              <div className="asst-confirm">
                <div className="asst-confirm-label">Confirm this change</div>
                <div className="asst-confirm-summary">{message.pendingAction.summary}</div>
                <div className="row" style={{ marginTop: 9 }}>
                  <button
                    className="ctrl primary sm"
                    disabled={confirming}
                    onClick={() => void confirm(index, message.pendingAction!)}
                  >
                    {confirming ? <span className="spin" /> : 'Apply'}
                  </button>
                  <button className="ctrl sm" disabled={confirming} onClick={() => decline(index)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {message.actionOutcome === 'applied' && (
              <div className="asst-outcome good">✓ Applied</div>
            )}
            {message.actionOutcome === 'declined' && (
              <div className="asst-outcome">Cancelled — nothing changed</div>
            )}
            {message.actionOutcome === 'failed' && (
              <div className="asst-outcome crit">
                Could not apply{message.outcomeDetail ? `: ${message.outcomeDetail}` : ''}
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="asst-msg assistant">
            <div className="asst-bubble asst-thinking">
              <span className="asst-dot" />
              <span className="asst-dot" />
              <span className="asst-dot" />
            </div>
          </div>
        )}
      </div>

      <form
        className="asst-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          placeholder="Ask, or tell me what to change…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button type="submit" className="ctrl primary sm" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
