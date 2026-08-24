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
import { TeamManager, type TeamMember } from '@/components/TeamManager';
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

  const teamMembers: TeamMember[] = members.map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role as TeamMember['role'],
    lastLogin: m.lastLoginAt ? formatRelativeTime(m.lastLoginAt) : 'never',
    isActive: m.isActive,
  }));

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

          <TeamManager
            members={teamMembers}
            currentUserId={session.user.id}
            currentRole={session.user.role as TeamMember['role']}
          />
        </div>
      </div>
    </div>
  );
}
