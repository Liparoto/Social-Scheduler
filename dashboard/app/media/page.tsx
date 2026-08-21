import Link from "next/link";
import { listAssetsWithUsage } from "@/lib/queries";
import { PageHeader, EmptyState } from "@/components/ui";
import { MediaManager } from "@/components/media-manager";

export const dynamic = "force-dynamic";

export default function MediaPage() {
  const assets = listAssetsWithUsage();

  return (
    <div>
      <PageHeader
        title="Media"
        subtitle="Every file in your asset store. Anything nothing else is using can be deleted to reclaim disk space."
      />
      <div className="px-8 py-6">
        {assets.length === 0 ? (
          <EmptyState title="No media yet">
            Upload something on{" "}
            <Link href="/compose" className="text-brand underline underline-offset-2">
              Compose
            </Link>
            .
          </EmptyState>
        ) : (
          <MediaManager assets={assets} />
        )}
      </div>
    </div>
  );
}
