'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Stage = 'idle' | 'scanning' | 'codes';

export function TwoFactorPanel({
  enabled,
  recoveryCodesRemaining,
}: {
  enabled: boolean;
  recoveryCodesRemaining: number;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('idle');
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/account/2fa', { method: 'POST' });
      const json = await res.json();
      if (json.ok) {
        setQr(json.data.qrDataUrl);
        setSecret(json.data.secret);
        setStage('scanning');
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/account/2fa', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const json = await res.json();
      if (json.ok) {
        setRecoveryCodes(json.data.recoveryCodes);
        setStage('codes');
        setCode('');
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(false);
    }
  }

  async function disable(event: React.FormEvent) {
    event.preventDefault();
    if (!confirm2fa()) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/account/2fa', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const json = await res.json();
      if (json.ok) {
        setMessage({ text: json.data.message, kind: 'good' });
        setCode('');
        setStage('idle');
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusy(false);
    }
  }

  function confirm2fa(): boolean {
    return window.confirm(
      'Turn off two-factor authentication? Your account will be protected by password alone.',
    );
  }

  return (
    <div className="card">
      <div className="ch">
        <h3>Two-factor authentication</h3>
        <span className={`pill ${enabled ? 'good' : 'neutral'}`}>{enabled ? 'On' : 'Off'}</span>
      </div>

      {message && (
        <div className={`banner ${message.kind}`} style={{ marginBottom: 12 }}>
          <span>{message.text}</span>
        </div>
      )}

      {/* One-time display of the recovery codes, right after enrolment. */}
      {stage === 'codes' && recoveryCodes && (
        <div>
          <div className="banner good" style={{ marginBottom: 12 }}>
            <span>Two-factor authentication is on.</span>
          </div>
          <p style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            <strong>Save these recovery codes now.</strong> Each one works once, and they are the
            only way back in if you lose your phone. They will not be shown again.
          </p>
          <div
            className="mono"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 8,
              padding: 12,
              background: 'var(--panel-2)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              fontSize: 12.5,
              margin: '10px 0 12px',
            }}
          >
            {recoveryCodes.map((rc) => (
              <span key={rc}>{rc}</span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="ctrl"
              onClick={() => navigator.clipboard?.writeText(recoveryCodes.join('\n'))}
            >
              Copy codes
            </button>
            <button
              className="ctrl primary"
              onClick={() => {
                setStage('idle');
                setRecoveryCodes(null);
              }}
            >
              I have saved them
            </button>
          </div>
        </div>
      )}

      {stage === 'scanning' && qr && (
        <form onSubmit={confirm}>
          <p style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: 0 }}>
            Scan this with an authenticator app (Google Authenticator, Authy, 1Password), then enter
            the 6-digit code it shows to finish.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qr}
            alt="Two-factor setup QR code"
            width={220}
            height={220}
            style={{ display: 'block', borderRadius: 8, background: '#fff', padding: 8 }}
          />
          {secret && (
            <div className="muted" style={{ fontSize: 11.5, margin: '10px 0', lineHeight: 1.6 }}>
              Cannot scan? Enter this key manually:{' '}
              <span className="mono" style={{ wordBreak: 'break-all' }}>
                {secret}
              </span>
            </div>
          )}
          <div style={{ marginTop: 12, marginBottom: 12 }}>
            <label htmlFor="tf-code">6-digit code</label>
            <input
              id="tf-code"
              className="mono"
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="one-time-code"
              placeholder="000000"
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ctrl primary" type="submit" disabled={busy}>
              {busy ? <span className="spin" /> : 'Turn on'}
            </button>
            <button className="ctrl" type="button" onClick={() => setStage('idle')}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {stage === 'idle' && !enabled && (
        <div>
          <p style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: 0 }}>
            Add a second step to sign-in using an authenticator app on your phone. Even someone who
            knows your password cannot get in without the rotating code.
          </p>
          <button className="ctrl primary" onClick={start} disabled={busy}>
            {busy ? <span className="spin" /> : 'Set up two-factor'}
          </button>
        </div>
      )}

      {stage === 'idle' && enabled && (
        <form onSubmit={disable}>
          <p style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: 0 }}>
            Sign-in requires a code from your authenticator app.{' '}
            <span className="muted">{recoveryCodesRemaining} recovery code(s) left.</span>
          </p>
          <div style={{ marginBottom: 12, maxWidth: 220 }}>
            <label htmlFor="tf-off">Enter a current code to turn it off</label>
            <input
              id="tf-off"
              className="mono"
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              placeholder="000000"
            />
          </div>
          <button className="ctrl danger" type="submit" disabled={busy}>
            {busy ? <span className="spin" /> : 'Turn off two-factor'}
          </button>
        </form>
      )}
    </div>
  );
}
