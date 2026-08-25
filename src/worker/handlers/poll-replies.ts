/**
 * Job: poll_replies
 *
 * Reads the sending mailbox over IMAP and ingests any replies found, so reply
 * detection does not depend on a provider webhook firing. A no-op unless IMAP
 * is configured, so it is safe to schedule unconditionally.
 */

import { pollInboxForReplies, imapConfigured } from '@/lib/inbound/imap-poll';
import type { JobHandler } from '../types';

export const pollRepliesHandler: JobHandler<Record<string, never>> = async (job) => {
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('poll_replies requires an organizationId');

  if (!imapConfigured()) {
    return { skipped: true, reason: 'IMAP not configured (set IMAP_ENABLED=true + credentials).' };
  }

  const result = await pollInboxForReplies(organizationId);
  if (result.error) {
    // Surface as a thrown error so the queue retries with backoff — a transient
    // IMAP hiccup should not silently drop a polling cycle.
    throw new Error(result.error);
  }
  return result;
};
