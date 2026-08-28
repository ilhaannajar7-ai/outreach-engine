'use client';

/**
 * Refresh control for server-rendered pages.
 *
 * Pages here are `force-dynamic`, so re-running the server render is all that's
 * needed to show current data. `router.refresh()` does that without a full
 * page reload, keeping scroll position and client state.
 *
 * `autoSeconds` turns on a quiet background refresh, for pages whose data moves
 * on its own (queue, jobs, health). The timer pauses while the tab is hidden —
 * refreshing a tab nobody is looking at only burns database queries.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function RefreshButton({
  autoSeconds,
  label = 'Refresh',
}: {
  autoSeconds?: number;
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [auto, setAuto] = useState(Boolean(autoSeconds));
  const [, forceTick] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    startTransition(() => {
      router.refresh();
      setLastRefreshed(new Date());
    });
  }, [router]);

  useEffect(() => {
    if (!auto || !autoSeconds) return;

    timer.current = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refresh();
    }, autoSeconds * 1000);

    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [auto, autoSeconds, refresh]);

  // Re-render once a minute so the "updated Xm ago" label stays honest.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {lastRefreshed && (
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--faint)' }}>
          {timeAgo(lastRefreshed)}
        </span>
      )}

      {autoSeconds && (
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            color: 'var(--muted)',
            cursor: 'pointer',
          }}
          title={`Refresh automatically every ${autoSeconds}s while this tab is visible`}
        >
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
            style={{ width: 'auto', margin: 0 }}
          />
          Auto
        </label>
      )}

      <button className="ctrl sm" onClick={refresh} disabled={pending} title="Reload this page's data">
        {pending ? <span className="spin" /> : `↻ ${label}`}
      </button>
    </span>
  );
}

function timeAgo(at: Date): string {
  const secs = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}
