import { getChannels, listPeriods, listTags } from "@/lib/queries";
import { BulkImport } from "@/components/bulk-import";

export const runtime = "nodejs";

export default function ImportPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold text-ink">Bulk import</h1>
        <p className="mt-1 text-sm text-muted">
          Add many images at once — each becomes a Draft you can tag, target, and schedule.
        </p>
      </header>
      <BulkImport
        channels={getChannels()}
        periods={listPeriods()}
        timeOfDayTags={listTags("time_of_day")}
        topicTags={listTags("topic")}
      />
    </div>
  );
}
