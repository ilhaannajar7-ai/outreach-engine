import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/db';
import { aiPrompts } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { DEFAULT_PROMPTS } from '@/lib/ai/prompts';
import { getUnreadCount } from '@/lib/notifications';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { PromptEditor } from '@/components/PromptEditor';

export const dynamic = 'force-dynamic';

export default async function PromptsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) redirect('/login');

  const orgId = session.user.organizationId;

  const [rows, unreadCount] = await Promise.all([
    db
      .select()
      .from(aiPrompts)
      .where(eq(aiPrompts.organizationId, orgId))
      .orderBy(aiPrompts.operation, desc(aiPrompts.version)),
    getUnreadCount(orgId),
  ]);

  // Fall back to the code defaults for any operation with no row yet, so the
  // editor always shows what the system is actually using.
  const prompts = (['research', 'email_generation', 'follow_up_generation', 'reply_classification'] as const).map(
    (operation) => {
      const versions = rows.filter((r) => r.operation === operation);
      const active = versions.find((v) => v.isActive) ?? versions[0];
      const fallback = DEFAULT_PROMPTS[operation];

      return {
        operation,
        systemPrompt: active?.systemPrompt ?? fallback.systemPrompt,
        userPromptTemplate: active?.userPromptTemplate ?? fallback.userPromptTemplate,
        version: active?.version ?? 0,
        updatedAt: (active?.updatedAt ?? new Date()).toISOString(),
        versions: versions.map((v) => ({
          version: v.version,
          isActive: v.isActive,
          updatedAt: v.updatedAt.toISOString(),
        })),
        defaultSystemPrompt: fallback.systemPrompt,
        defaultUserPromptTemplate: fallback.userPromptTemplate,
      };
    },
  );

  return (
    <div className="shell">
      <Sidebar />

      <div className="main">
        <TopBar
          title="AI prompts"
          subtitle="The instructions behind each operation — versioned, editable, revertible"
          unreadCount={unreadCount}
        />

        <div className="content">
          <PromptEditor
            prompts={prompts}
            canEdit={session.user.role === 'owner' || session.user.role === 'admin'}
          />
        </div>
      </div>
    </div>
  );
}
