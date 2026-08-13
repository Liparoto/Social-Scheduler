import Link from "next/link";
import { PageHeader, EmptyState } from "@/components/ui";
import { BppMark } from "@/components/bpp-mark";
import { getBppEntries, getBppUnits } from "@/lib/insights-queries";
import { exact } from "@/lib/insights";

export const dynamic = "force-dynamic";

/*
  The BPP pool — your keepers, as a set.

  Marking happens while reviewing stats, one post at a time, on the Insights leaderboard.
  This is the other half of that workflow: seeing the pool whole, so "do I have enough
  for the cadence I set" and "what is about to go out again" are answerable at a glance
  rather than inferred from the queue.

  Ordered exactly as auto-fill will use it — longest-since-posted first — so the order on
  screen is the running order, not an approximation of it.
*/

function sinceLabel(iso: string | null): string {
  if (!iso) return "not since marking";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export default function BppPoolPage() {
  const entries = getBppEntries();
  const units = getBppUnits();

  return (
    <div>
      <PageHeader
        title="BPP Pool"
        subtitle="The posts you've marked worth running again — in the order they'll be used."
      />

      <div className="space-y-6 px-8 py-6">
        {/* Cadence per account, with the consequence spelled out. The pool is shared, but
            what each account can SEND differs — a post targeted only at Instagram is not
            in the Threads rotation, and a cadence set against the raw count would quietly
            under-deliver. */}
        <section className="rounded-card border border-border bg-surface">
          <div className="border-b border-border px-5 py-3">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted">
              Rotation
            </h2>
          </div>
          <ul className="divide-y divide-border">
            {units.map((unit) => {
              const period = unit.everyDays > 0 ? unit.usable * unit.everyDays : null;
              return (
                <li key={unit.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <span className="text-sm text-ink">{unit.label}</span>
                  <span className="text-[11px] text-muted">
                    {unit.everyDays === 0 ? (
                      <>
                        rotation off —{" "}
                        <Link href="/channels" className="text-brand-strong underline">
                          set a cadence
                        </Link>
                      </>
                    ) : unit.usable === 0 ? (
                      <span className="text-status-publishing">
                        every <span className="data">{unit.everyDays}</span> days, but
                        nothing in the pool can go out here
                      </span>
                    ) : (
                      <>
                        <span className="data">{unit.usable}</span> usable · one every{" "}
                        <span className="data">{unit.everyDays}</span> days ·{" "}
                        <span className={period !== null && period < 90 ? "text-status-publishing" : ""}>
                          each returns about every <span className="data">{period}</span> days
                        </span>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {entries.length === 0 ? (
          <EmptyState title="Nothing marked yet">
            Mark posts from{" "}
            <Link href="/insights" className="text-brand-strong underline">
              Insights
            </Link>{" "}
            → an account → Top content. The ★ Standouts filter narrows it to posts that
            beat their contemporaries, which is the short list worth reviewing.
          </EmptyState>
        ) : (
          <section className="rounded-card border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted">
                {exact(entries.length)} marked · next up first
              </h2>
            </div>
            <ul className="divide-y divide-border">
              {entries.map((entry, index) => (
                <li key={entry.post_id} className="flex items-center gap-3 px-5 py-3">
                  <span
                    className={`data w-6 shrink-0 text-center text-[11px] ${
                      index === 0 ? "font-semibold text-brand-strong" : "text-faint"
                    }`}
                    title={index === 0 ? "Next in the rotation" : undefined}
                  >
                    {index + 1}
                  </span>
                  <span className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-surface-sunken" aria-hidden>
                    {entry.asset_id ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/media/${entry.asset_id}`}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/library/${entry.post_id}`}
                      className="block truncate text-[13px] text-ink-soft hover:underline"
                    >
                      {entry.caption?.trim().split("\n")[0] || "No caption"}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-faint">
                      last posted {sinceLabel(entry.last_posted)}
                      {entry.targets ? ` · ${entry.targets}` : " · no channels targeted"}
                      {entry.content_status !== "ready" ? (
                        <span className="text-status-publishing">
                          {" "}· not ready, so it will be skipped
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <BppMark postId={entry.post_id} initial />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
