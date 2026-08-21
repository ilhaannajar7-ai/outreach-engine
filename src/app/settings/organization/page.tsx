import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { organizations, organizationMembers, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { OrganizationForm } from '@/components/OrganizationForm';
import { formatRelativeTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function OrganizationPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [orgRows, members, unreadCount] = await Promise.all([
    db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1),
    db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: organizationMembers.role,
        lastLoginAt: users.lastLoginAt,
        isActive: users.isActive,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(eq(organizationMembers.organizationId, orgId)),
    getUnreadCount(orgId),
  ]);

  const organization = orgRows[0];
  if (!organization) redirect('/login');

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="Organization"
          subtitle="Who you are and what you sell — this is what the AI writes about"
          unreadCount={unreadCount}
        />

        <div className="content">
          <OrganizationForm
            organization={{
              name: organization.name,
              valueProposition: organization.valueProposition,
              servicesOffered: organization.servicesOffered,
              targetIndustries: organization.targetIndustries,
              senderName: organization.senderName,
              senderTitle: organization.senderTitle,
              calendarLink: organization.calendarLink,
            }}
            canEdit={session.user.role === 'owner' || session.user.role === 'admin'}
          />

          <div className="card">
            <div className="ch">
              <h3>Team</h3>
              <span className="hint">
                {members.length} member{members.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Last sign-in</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr key={member.userId}>
                      <td style={{ fontWeight: 600 }}>{member.name ?? '—'}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {member.email}
                      </td>
                      <td>
                        <span className={`pill ${member.role === 'owner' ? 'int' : 'neutral'}`}>
                          {member.role}
                        </span>
                      </td>
                      <td className="muted">
                        {member.lastLoginAt ? formatRelativeTime(member.lastLoginAt) : 'never'}
                      </td>
                      <td>
                        <span className={`pill ${member.isActive ? 'good' : 'crit'}`}>
                          {member.isActive ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.7 }}>
              Adding a teammate is a server-side action, deliberately — it creates a password. Run:
              <div
                className="mono"
                style={{
                  marginTop: 6,
                  padding: '8px 11px',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  fontSize: 11,
                  wordBreak: 'break-all',
                }}
              >
                docker compose exec web sh -c &apos;SEED_ADMIN_EMAIL=them@company.com
                SEED_ADMIN_PASSWORD=&quot;their-password&quot; npx tsx src/db/seed.ts&apos;
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
