import Link from "next/link";
import { getActiveChannels } from "@/lib/queries";
import { config } from "@/lib/config";
import { PageHeader, EmptyState } from "@/components/ui";
import { Composer } from "@/components/composer";

export const dynamic = "force-dynamic";

export default function ComposePage() {
  const channels = getActiveChannels().map((c) => ({
    id: c.id,
    platform: c.platform,
    account_name: c.account_name,
    timezone: c.timezone,
    requires_approval: c.requires_approval === 1,
  }));

  return (
    <div>
      <PageHeader
        title="Compose"
        subtitle="Assemble a post, set its order, and choose exactly where it goes."
      />
      <div className="px-8 py-6">
        {channels.length === 0 ? (
          <EmptyState title="Add a channel first">
            You need at least one active account before composing. Head to{" "}
            <Link href="/channels" className="text-brand underline underline-offset-2">
              Channels
            </Link>
            .
          </EmptyState>
        ) : (
          <Composer channels={channels} defaultTimezone={config.defaultTimezone} />
        )}
      </div>
    </div>
  );
}
