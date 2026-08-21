import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { campaigns } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getUnreadCount } from '@/lib/notifications';
import { getExperimentResults } from '@/lib/experiments';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { ExperimentsPanel } from '@/components/ExperimentsPanel';

export const dynamic = 'force-dynamic';

export default async function ExperimentsPage({
  searchParams,
}: {
  searchParams: Promise<{ campaignId?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;
  const params = await searchParams;

  const campaignId =
    params.campaignId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.campaignId)
      ? params.campaignId
      : null;

  const [results, campaignList, unreadCount] = await Promise.all([
    getExperimentResults({ organizationId: orgId, campaignId }),
    db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.organizationId, orgId))
      .orderBy(desc(campaigns.createdAt)),
    getUnreadCount(orgId),
  ]);

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="Strategy testing"
          subtitle={
            results.variants.length > 0
              ? `${results.variants.length} variants · ${results.totalSent} sends measured`
              : 'Find the angle that actually gets replies'
          }
          unreadCount={unreadCount}
        />

        <div className="content">
          <ExperimentsPanel
            readout={{
              variants: results.variants.map((v) => ({
                id: v.id,
                name: v.name,
                isControl: v.isControl,
                sent: v.sent,
                replied: v.replied,
                interested: v.interested,
                replyRate: v.replyRate,
                interestedRate: v.interestedRate,
                verdict: v.verdict,
                explanation: v.explanation,
                pValue: v.comparison?.pValue ?? null,
                lift: v.comparison?.lift ?? null,
              })),
              details: results.variantDetails,
              winnerId: results.winner?.id ?? null,
              totalSent: results.totalSent,
              summary: results.summary,
              alpha: results.alpha,
              recommendedSampleSize: results.recommendedSampleSize,
            }}
            campaigns={campaignList}
            activeCampaignId={campaignId}
            canEdit={session.user.role !== 'viewer'}
          />
        </div>
      </div>
    </div>
  );
}
