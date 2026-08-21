'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function JobRetryButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      if (response.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="ctrl sm" onClick={() => void retry()} disabled={busy}>
      {busy ? <span className="spin" /> : 'Retry'}
    </button>
  );
}
