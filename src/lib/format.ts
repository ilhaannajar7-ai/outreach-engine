/**
 * Display formatters shared by server and client components.
 *
 * These live outside `src/app` because Next.js page modules may only export
 * the framework's reserved names — a stray helper export fails the build.
 */

export function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Maps a lead status onto one of the `.pill` colour classes. */
export function statusPill(status: string): string {
  if (status === 'interested' || status === 'meeting_booked') return 'int';
  if (status === 'new') return 'new';
  if (status.startsWith('follow_up') || status === 'contacted') return 'fu';
  if (status === 'ready_to_contact' || status === 'replied') return 'rev';
  if (status === 'error' || status === 'bounced' || status === 'not_interested') return 'crit';
  return 'neutral';
}

export function formatOperation(operation: string): string {
  return (
    {
      research: 'Research',
      email_generation: 'Email generation',
      follow_up_generation: 'Follow-ups',
      reply_classification: 'Reply classify',
    }[operation] ?? formatStatus(operation)
  );
}

export function formatComponent(component: string): string {
  return (
    {
      ai: 'Claude API',
      email: 'Email provider',
      enrichment: 'Enrichment',
      database: 'Database',
    }[component] ?? formatStatus(component)
  );
}

export function formatCurrency(value: number, decimals = 2): string {
  return `$${value.toFixed(decimals)}`;
}

export function formatRelativeTime(date: Date | string): string {
  const then = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return then.toLocaleDateString();
}
