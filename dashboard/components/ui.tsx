import type { PublicationStatus } from "@/lib/types";
import { channelColor } from "@/lib/format";
import { platformBadge } from "@/lib/platforms";

const STATUS_META: Record<
  PublicationStatus,
  { label: string; varName: string }
> = {
  scheduled: { label: "Scheduled", varName: "--color-status-scheduled" },
  pending_approval: { label: "Needs approval", varName: "--color-status-draft" },
  publishing: { label: "Publishing", varName: "--color-status-publishing" },
  posted: { label: "Posted", varName: "--color-status-posted" },
  failed: { label: "Failed", varName: "--color-status-failed" },
  canceled: { label: "Canceled", varName: "--color-status-draft" },
};

export function StatusBadge({
  status,
  dryRun,
}: {
  status: PublicationStatus;
  dryRun?: boolean;
}) {
  const meta = STATUS_META[status];
  const color = `var(${meta.varName})`;
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium"
        style={{ color, backgroundColor: `color-mix(in srgb, ${color} 12%, white)` }}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        {meta.label}
      </span>
      {dryRun ? (
        <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-muted">
          dry-run
        </span>
      ) : null}
    </span>
  );
}

/**
 * A channel's account profile photo, or a coloured circle with its initial.
 *
 * Both branches render at exactly `size`, so a chip never changes shape depending on
 * whether a photo has been fetched yet. The fallback uses the channel's accent colour and
 * first initial rather than a generic placeholder: two channels on the same platform are
 * told apart by the initial, which a plain dot could not do.
 *
 * Decorative — the account name is always rendered next to it — so it is hidden from
 * assistive tech rather than repeating that name.
 */
export function ChannelAvatar({
  id,
  name,
  colorHue,
  avatarPath,
  size = 14,
}: {
  id: number;
  name: string;
  colorHue?: number | null;
  avatarPath?: string | null;
  size?: number;
}) {
  const c = channelColor(id, colorHue);
  const dimensions = { width: size, height: size };

  if (avatarPath) {
    return (
      // next/image would add an optimizer round-trip for a local file we already serve at the right size.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/channels/${id}/avatar`}
        alt=""
        aria-hidden
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={dimensions}
      />
    );
  }

  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ ...dimensions, backgroundColor: c.fg, fontSize: Math.round(size * 0.55) }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function ChannelChip({
  id,
  platform,
  name,
  colorHue,
  avatarPath,
}: {
  id: number;
  platform: string;
  name: string;
  colorHue?: number | null;
  avatarPath?: string | null;
}) {
  const c = channelColor(id, colorHue);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ color: c.fg, backgroundColor: c.bg }}
    >
      <ChannelAvatar id={id} name={name} colorHue={colorHue} avatarPath={avatarPath} size={14} />
      {name}
      <span className="text-[10px] uppercase tracking-wide opacity-60">
        {platformBadge(platform)}
      </span>
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-border px-8 py-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-border-strong bg-surface/60 px-6 py-12 text-center">
      <p className="font-display text-base font-medium text-ink-soft">{title}</p>
      {children ? (
        <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>
      ) : null}
    </div>
  );
}
