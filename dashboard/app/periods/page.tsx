import { listPeriods } from "@/lib/queries";
import { PageHeader, EmptyState } from "@/components/ui";
import { PeriodAdd, PeriodCard } from "@/components/period-manager";

export const dynamic = "force-dynamic";

export default function PeriodsPage() {
  const periods = listPeriods();

  return (
    <div>
      <PageHeader
        title="Periods"
        subtitle="Reusable in-season windows. Attach any to a post as green (in-season) or blackout (excluded) when you compose."
      />

      <div className="px-8 py-6 space-y-6">
        <PeriodAdd />

        {periods.length === 0 ? (
          <EmptyState title="No periods yet">
            Create windows like <em>Winter</em>, <em>July 4th</em>, or a one-off event range.
            Then a post tagged for that window only auto-posts while it&rsquo;s in season.
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {periods.map((p) => (
              <PeriodCard key={p.id} period={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
