import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { campaigns, leads } from '@/db/schema';
import { eq, desc, sql as dsql } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { CampaignsPanel } from '@/components/CampaignsPanel';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [rows, unreadCount] = await Promise.all([
    db
      .select({
        campaign: campaigns,
        leadCount: dsql<number>`COUNT(${leads.id})::int`,
        contactedCount: dsql<number>`COUNT(${leads.id}) FILTER (WHERE ${leads.firstContactedAt} IS NOT NULL)::int`,
        repliedCount: dsql<number>`COUNT(${leads.id}) FILTER (WHERE ${leads.repliedAt} IS NOT NULL)::int`,
        interestedCount: dsql<number>`COUNT(${leads.id}) FILTER (WHERE ${leads.status} = 'interested')::int`,
      })
      .from(campaigns)
      .leftJoin(leads, eq(leads.campaignId, campaigns.id))
      .where(eq(campaigns.organizationId, orgId))
      .groupBy(campaigns.id)
      .orderBy(desc(campaigns.createdAt)),
    getUnreadCount(orgId),
  ]);

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="Campaigns"
          subtitle={`${rows.length} campaign${rows.length === 1 ? '' : 's'}`}
          unreadCount={unreadCount}
        />

        <div className="content">
          <CampaignsPanel
            campaigns={rows.map((r) => ({
              id: r.campaign.id,
              name: r.campaign.name,
              description: r.campaign.description,
              status: r.campaign.status,
              targetRole: r.campaign.targetRole,
              targetIndustry: r.campaign.targetIndustry,
              targetLocation: r.campaign.targetLocation,
              maxFollowUps: r.campaign.maxFollowUps,
              followUp1DelayDays: r.campaign.followUp1DelayDays,
              followUp2DelayDays: r.campaign.followUp2DelayDays,
              toneInstructions: r.campaign.toneInstructions,
              customPromptAdditions: r.campaign.customPromptAdditions,
              createdAt: r.campaign.createdAt.toISOString(),
              leadCount: r.leadCount,
              contactedCount: r.contactedCount,
              repliedCount: r.repliedCount,
              interestedCount: r.interestedCount,
            }))}
            canEdit={session.user.role !== 'viewer'}
          />
        </div>
      </div>
    </div>
  );
}
