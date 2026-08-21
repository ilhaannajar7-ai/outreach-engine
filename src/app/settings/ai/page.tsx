import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { aiModelConfig } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { AVAILABLE_MODELS } from '@/lib/ai/config';
import { getBudgetStatus, getUsageByOperation, getDailySpend } from '@/lib/ai/budget';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { AiConfigPanel } from '@/components/AiConfigPanel';

export const dynamic = 'force-dynamic';

export default async function AiSettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [models, budget, byOperation, dailySpend, unreadCount] = await Promise.all([
    db.select().from(aiModelConfig).where(eq(aiModelConfig.organizationId, orgId)),
    getBudgetStatus(orgId),
    getUsageByOperation(orgId),
    getDailySpend(orgId, 30),
    getUnreadCount(orgId),
  ]);

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="AI configuration"
          subtitle="Model per operation, spend limits, and prompts — all applied without a redeploy"
          unreadCount={unreadCount}
        />

        <div className="content">
          <AiConfigPanel
            models={models.map((m) => ({
              operation: m.operation,
              model: m.model,
              maxTokens: m.maxTokens,
              temperature: Number(m.temperature),
              isEnabled: m.isEnabled,
            }))}
            availableModels={[...AVAILABLE_MODELS]}
            budget={budget}
            byOperation={byOperation}
            dailySpend={dailySpend}
            canEdit={session.user.role === 'owner' || session.user.role === 'admin'}
          />
        </div>
      </div>
    </div>
  );
}
