'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
type Role = (typeof ROLES)[number];

const ROLE_HELP: Record<Role, string> = {
  owner: 'Full control of everything, including ownership. Only an owner can add, remove, or change another owner.',
  admin: 'Manage day to day — leads, sending, settings, and the team (add, remove, and re-role members). Cannot remove or change the owner.',
  member: 'Do the work — import, research, generate, approve, and send — but cannot change settings or manage the team.',
  viewer: 'Read-only. Can view dashboards and reports, and change nothing at all.',
};

/** What each role can do, shown as a matrix so access is explicit, not implied. */
const CAPABILITIES: { label: string; allowed: Record<Role, boolean> }[] = [
  {
    label: 'View dashboards & reports',
    allowed: { owner: true, admin: true, member: true, viewer: true },
  },
  {
    label: 'Run outreach (import → research → generate → approve & send)',
    allowed: { owner: true, admin: true, member: true, viewer: false },
  },
  {
    label: 'Change settings (AI, sending, prompts)',
    allowed: { owner: true, admin: true, member: false, viewer: false },
  },
  {
    label: 'Manage team — add, remove & re-role members',
    allowed: { owner: true, admin: true, member: false, viewer: false },
  },
  {
    label: 'Add, remove, or change the owner',
    allowed: { owner: true, admin: false, member: false, viewer: false },
  },
];

export interface TeamMember {
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  lastLogin: string;
  isActive: boolean;
}

export function TeamManager({
  members,
  currentUserId,
  currentRole,
}: {
  members: TeamMember[];
  currentUserId: string;
  currentRole: Role;
}) {
  const router = useRouter();
  const canManage = currentRole === 'owner' || currentRole === 'admin';
  const isOwner = currentRole === 'owner';

  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'good' | 'crit' } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'member' as Role, password: '' });
  const [adding, setAdding] = useState(false);

  async function changeRole(userId: string, role: Role) {
    setBusyId(userId);
    setMessage(null);
    try {
      const res = await fetch(`/api/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const json = await res.json();
      if (json.ok) {
        setMessage({ text: json.data.message, kind: 'good' });
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(userId: string, email: string) {
    if (!confirm(`Remove ${email} from this organization? Their login will stop working.`)) return;
    setBusyId(userId);
    setMessage(null);
    try {
      const res = await fetch(`/api/members/${userId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.ok) {
        setMessage({ text: json.data.message, kind: 'good' });
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setBusyId(null);
    }
  }

  async function addMember(event: React.FormEvent) {
    event.preventDefault();
    setAdding(true);
    setMessage(null);
    try {
      const res = await fetch('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (json.ok) {
        setMessage({ text: json.data.message, kind: 'good' });
        setForm({ email: '', name: '', role: 'member', password: '' });
        setShowAdd(false);
        router.refresh();
      } else {
        setMessage({ text: json.error, kind: 'crit' });
      }
    } catch {
      setMessage({ text: 'Could not reach the server.', kind: 'crit' });
    } finally {
      setAdding(false);
    }
  }

  // An admin cannot edit an owner row; only an owner can.
  const canEditRow = (role: Role) => canManage && (role !== 'owner' || isOwner);
  const roleOptions = ROLES.filter((r) => r !== 'owner' || isOwner);

  return (
    <>
      <div className="card">
        <div className="ch">
          <h3>Role permissions</h3>
          <span className="hint">what each role can do</span>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Capability</th>
                <th style={{ textAlign: 'center' }}>Owner</th>
                <th style={{ textAlign: 'center' }}>Admin</th>
                <th style={{ textAlign: 'center' }}>Member</th>
                <th style={{ textAlign: 'center' }}>Viewer</th>
              </tr>
            </thead>
            <tbody>
              {CAPABILITIES.map((cap) => (
                <tr key={cap.label}>
                  <td style={{ fontSize: 12.5 }}>{cap.label}</td>
                  {(ROLES as readonly Role[]).map((role) => (
                    <td key={role} style={{ textAlign: 'center' }}>
                      {cap.allowed[role] ? (
                        <span style={{ color: 'var(--good)', fontWeight: 700 }}>✓</span>
                      ) : (
                        <span style={{ color: 'var(--faint)' }}>—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.6 }}>
          Access is enforced everywhere — a viewer cannot change anything, a member cannot reach
          settings or the team, and only an owner can add, remove, or change another owner.
        </div>
      </div>

      <div className="card">
        <div className="ch">
          <h3>Team</h3>
          <span className="hint">
            {members.length} member{members.length === 1 ? '' : 's'}
          </span>
        </div>

      {message && (
        <div className={`banner ${message.kind}`} style={{ marginBottom: 12 }}>
          <span>{message.text}</span>
        </div>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Last sign-in</th>
              <th>Status</th>
              {canManage && <th aria-label="actions"></th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td style={{ fontWeight: 600 }}>
                  {m.name ?? '—'}
                  {m.userId === currentUserId && <span className="muted"> (you)</span>}
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {m.email}
                </td>
                <td>
                  {canEditRow(m.role) ? (
                    <select
                      value={m.role}
                      disabled={busyId === m.userId}
                      onChange={(e) => changeRole(m.userId, e.target.value as Role)}
                      title={ROLE_HELP[m.role]}
                    >
                      {roleOptions.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className={`pill ${m.role === 'owner' ? 'int' : 'neutral'}`}>{m.role}</span>
                  )}
                </td>
                <td className="muted">{m.lastLogin}</td>
                <td>
                  <span className={`pill ${m.isActive ? 'good' : 'crit'}`}>
                    {m.isActive ? 'Active' : 'Disabled'}
                  </span>
                </td>
                {canManage && (
                  <td>
                    {m.userId !== currentUserId && canEditRow(m.role) && (
                      <button
                        className="ctrl danger"
                        disabled={busyId === m.userId}
                        onClick={() => removeMember(m.userId, m.email)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div style={{ marginTop: 14 }}>
          {!showAdd ? (
            <button className="ctrl primary" onClick={() => setShowAdd(true)}>
              + Add member
            </button>
          ) : (
            <form onSubmit={addMember} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label htmlFor="tm-name">Name</label>
                  <input
                    id="tm-name"
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="tm-email">Email (their login)</label>
                  <input
                    id="tm-email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="tm-role">Role</label>
                  <select
                    id="tm-role"
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
                  >
                    {roleOptions.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="tm-pw">Temporary password (10+ chars)</label>
                  <input
                    id="tm-pw"
                    type="text"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    minLength={10}
                    required
                    placeholder="share this with them"
                  />
                </div>
              </div>
              <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
                {ROLE_HELP[form.role]} You set a temporary password and share it with them securely —
                there is no self-serve password reset yet.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="ctrl primary" type="submit" disabled={adding}>
                  {adding ? <span className="spin" /> : 'Add member'}
                </button>
                <button className="ctrl" type="button" onClick={() => setShowAdd(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
        )}
      </div>
    </>
  );
}
