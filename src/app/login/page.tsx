'use client';

import { useState, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Only rendered once the password has been accepted and the account turns
  // out to have 2FA on — so accounts without it keep a one-step sign-in.
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await signIn('credentials', {
      email,
      password,
      ...(needsCode ? { totp: code } : {}),
      redirect: false,
    });

    if (result?.error) {
      if (result.error === '2FA_REQUIRED') {
        setNeedsCode(true);
        setError(null);
      } else if (result.error === '2FA_INVALID') {
        setError('That code is not right. Check your authenticator app and try again.');
        setCode('');
      } else {
        // Deliberately generic — a distinct "no such user" message would let
        // anyone enumerate which addresses have accounts.
        setError('Incorrect email or password.');
        setNeedsCode(false);
        setCode('');
      }
      setSubmitting(false);
      return;
    }

    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <form onSubmit={submit}>
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          autoComplete="username"
          disabled={needsCode}
        />
      </div>

      <div style={{ marginBottom: 18 }}>
        <label htmlFor="password">Password</label>
        <div style={{ position: 'relative' }}>
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            disabled={needsCode}
            style={{ width: '100%', paddingRight: 42 }}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            title={showPassword ? 'Hide password' : 'Show password'}
            style={{
              position: 'absolute',
              right: 6,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 6,
              lineHeight: 0,
              color: 'var(--muted)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {showPassword ? (
              // Eye with a slash — password is currently visible.
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {needsCode && (
        <div style={{ marginBottom: 18 }}>
          <label htmlFor="totp">Authentication code</label>
          <input
            id="totp"
            type="text"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
            autoComplete="one-time-code"
            placeholder="6-digit code"
            className="mono"
          />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
            Open your authenticator app and enter the current code. Lost your phone? Enter one of
            your recovery codes instead.
          </div>
        </div>
      )}

      {error && (
        <div className="banner crit" style={{ marginBottom: 14 }}>
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        className="ctrl primary"
        disabled={submitting}
        style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
      >
        {submitting ? <span className="spin" /> : needsCode ? 'Verify and sign in' : 'Sign in'}
      </button>

      {needsCode && (
        <button
          type="button"
          className="ctrl"
          onClick={() => {
            setNeedsCode(false);
            setCode('');
            setError(null);
          }}
          style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
        >
          Back
        </button>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 800,
              fontSize: 16,
            }}
          >
            O
          </div>
          <div>
            <div style={{ fontWeight: 750, fontSize: 16, letterSpacing: '-0.01em' }}>Outreach</div>
            <div
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: '0.1em',
                color: 'var(--muted)',
                fontWeight: 600,
                textTransform: 'uppercase',
              }}
            >
              Command Center
            </div>
          </div>
        </div>

        <div className="card">
          <h1 style={{ margin: '0 0 4px', fontSize: '1.1rem', fontWeight: 750 }}>Sign in</h1>
          <p style={{ margin: '0 0 18px', fontSize: 12.5, color: 'var(--muted)' }}>
            Enter your credentials to open the dashboard.
          </p>

          <Suspense fallback={<div className="spin" />}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
