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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await signIn('credentials', { email, password, redirect: false });

    if (result?.error) {
      // Deliberately generic — a distinct "no such user" message would let
      // anyone enumerate which addresses have accounts.
      setError('Incorrect email or password.');
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
        />
      </div>

      <div style={{ marginBottom: 18 }}>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </div>

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
        {submitting ? <span className="spin" /> : 'Sign in'}
      </button>
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
