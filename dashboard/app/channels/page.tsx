import { getBppPool } from "@/lib/insights-queries";
import { getChannels, listChannelGroups, getGroupMembers, getBandCounts } from "@/lib/queries";
import { config } from "@/lib/config";
import {
  accountIdLabel,
  oauthConnectPath,
  platformLabel,
  supportsAvatar,
  usesAccountId,
} from "@/lib/platforms";
import { PageHeader, ChannelChip, ChannelAvatar, EmptyState } from "@/components/ui";
import { ChannelForm } from "@/components/channel-form";
import { ChannelToggle } from "@/components/channel-toggles";
import { ChannelCredentials } from "@/components/channel-credentials";
import { ChannelAvatarRefresh } from "@/components/channel-avatar-refresh";
import { ChannelColor } from "@/components/channel-color";
import { ChannelName } from "@/components/channel-name";
import { ChannelTimezone } from "@/components/channel-timezone";
import { AutofillConfig } from "@/components/autofill-config";
import { ChannelGroups } from "@/components/channel-groups";
import { ChannelGroupSelect } from "@/components/channel-group-select";
import { tzAbbrev } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{
    tiktok_connected?: string;
    tiktok_reconnected?: string;
    tiktok_error?: string;
  }>;
}) {
  // The TikTok OAuth callback redirects here with an outcome. Without showing it, a failed
  // connection looks identical to a successful one that simply has not appeared yet.
  const params = await searchParams;
  const channels = getChannels();
  const groups = listChannelGroups().map((g) => ({
    id: g.id,
    name: g.name,
    timezone: g.timezone,
    autofill_enabled: g.autofill_enabled,
    cadence_config: g.cadence_config,
    min_queue_depth: g.min_queue_depth,
    target_queue_depth: g.target_queue_depth,
    reuse_min_age_days: g.reuse_min_age_days,
    bpp_every_days: g.bpp_every_days,
    // Pool is measured against a MEMBER: a group sends what its members can send.
    bpp_pool_size: getBppPool(getGroupMembers(g.id)[0]?.id ?? 0).usable,
    band_counts: getBandCounts(getGroupMembers(g.id).map((m) => m.id)),
    members: getGroupMembers(g.id).map((m) => ({
      id: m.id,
      account_name: m.account_name,
      platform: m.platform,
    })),
  }));
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
  const groupTimezones = new Map(groups.map((g) => [g.id, g.timezone]));

  return (
    <div>
      <PageHeader
        title="Channels"
        subtitle="Each social account is configured independently — its own credentials, timezone, and rules."
      />

      <div className="px-8 py-6 space-y-6">
        {params.tiktok_connected ? (
          <div className="rounded-card border border-border bg-surface-muted p-4 text-sm text-ink-soft">
            {params.tiktok_reconnected === "1" ? (
              <>
                <span className="font-medium text-ink">TikTok reconnected.</span> The
                existing channel was refreshed with new credentials — its queue, history
                and name are untouched.
              </>
            ) : (
              <>
                <span className="font-medium text-ink">TikTok connected.</span> Run{" "}
                <code>python -m worker.preflight</code> to confirm it, then schedule a
                video. Remember: TikTok delivers the video to your inbox — you write the
                caption and publish in the app.
              </>
            )}
          </div>
        ) : null}
        {params.tiktok_error ? (
          <div className="rounded-card border border-status-failed bg-surface-muted p-4 text-sm text-status-failed">
            {params.tiktok_error}
          </div>
        ) : null}
        <ChannelForm
          defaultTimezone={config.defaultTimezone}
          nextChannelId={channels.reduce((max, c) => Math.max(max, c.id), 0) + 1}
        />

        {channels.length === 0 ? (
          <EmptyState title="No channels configured">
            Add your first account above — Instagram, Facebook, Threads, Discord,
            Telegram, or TikTok. Most need an account id and a long-lived access token;
            Discord just needs a webhook URL, and TikTok connects through your browser.
          </EmptyState>
        ) : (
          <>
          <ChannelGroups
            groups={groups}
            defaultTimezone={config.defaultTimezone}
            bandTimes={config.bandTimes}
          />
          <div className="grid gap-4 md:grid-cols-2">
            {channels.map((c) => (
              <div
                key={c.id}
                className={`rounded-card border bg-surface p-5 ${
                  c.is_active ? "border-border" : "border-border opacity-60"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <ChannelAvatar
                      id={c.id}
                      name={c.account_name}
                      colorHue={c.color_hue}
                      avatarPath={c.avatar_path}
                      size={40}
                    />
                    <div>
                      <ChannelChip id={c.id} platform={c.platform} name={c.account_name} colorHue={c.color_hue} />
                      {c.business_label ? (
                        <p className="mt-1.5 text-xs text-muted">{c.business_label}</p>
                      ) : null}
                      {/* usesAccountId was standing in for "has a profile photo", which
                          was true until TikTok: it has an account id AND no avatar this
                          worker reads. Offering the button there sets a flag the avatar
                          job excludes in SQL, so it is never acted on and never cleared —
                          it would read "Requested" forever. */}
                      {usesAccountId(c.platform) && supportsAvatar(c.platform) ? (
                        <ChannelAvatarRefresh
                          channelId={c.id}
                          avatarError={c.avatar_error}
                        />
                      ) : null}
                    </div>
                  </div>
                  <span className="data text-[11px] text-faint">#{c.id}</span>
                </div>

                <dl className="mt-4 space-y-1.5 text-xs">
                  <Row label="Timezone">
                    <span className="data text-ink-soft">
                      {c.timezone} · {tzAbbrev(c.timezone)}
                    </span>
                  </Row>
                  {usesAccountId(c.platform) ? (
                    <Row label={accountIdLabel(c.platform)}>
                      <span className="data text-ink-soft">
                        {c.remote_account_id || <span className="text-faint">not set</span>}
                      </span>
                    </Row>
                  ) : null}
                  <Row label="Access token">
                    <span className="text-ink-soft">
                      {c.access_token ? (
                        <span className="text-status-posted">configured</span>
                      ) : (
                        <span className="text-status-failed">missing</span>
                      )}
                    </span>
                  </Row>
                </dl>

                <div className="mt-4 flex flex-wrap gap-2">
                  <ChannelToggle
                    id={c.id}
                    field="requires_approval"
                    value={c.requires_approval === 1}
                    labelOn="Approval required"
                    labelOff="No approval"
                  />
                  <ChannelToggle
                    id={c.id}
                    field="is_active"
                    value={c.is_active === 1}
                    labelOn="Active"
                    labelOff="Inactive"
                  />
                </div>

                <ChannelCredentials
                  channelId={c.id}
                  platform={c.platform}
                  remoteAccountId={c.remote_account_id}
                />

                {/* A grouped channel doesn't own its timezone — the group does, and
                    rebasing one member alone would desynchronize the group. The API
                    rejects it too; this just stops the control being offered. */}
                {c.group_id === null ? (
                  <ChannelTimezone target={{ kind: "channel", id: c.id }} timezone={c.timezone} />
                ) : (
                  <p className="mt-3 rounded-lg border border-border bg-surface-sunken/40 p-3 text-xs text-muted">
                    Timezone is changed on{" "}
                    <span className="font-medium text-ink-soft">
                      {groupNames.get(c.group_id)}
                    </span>
                    , which auto-fills in{" "}
                    <span className="data text-ink-soft">
                      {groupTimezones.get(c.group_id)}
                    </span>
                    . Moving this channel on its own would pull its sends off the slots
                    it shares with the rest of the group.
                  </p>
                )}

                {/* Reconnect lives on the CARD, not only in the add form. A TikTok
                    channel needs re-authorizing when its yearly refresh token expires or
                    when a new scope is added, and routing that through "Add channel"
                    both hides it and implies it would create a duplicate. */}
                {oauthConnectPath(c.platform) ? (
                  <div className="mt-3 rounded-lg border border-border bg-surface-sunken/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-ink-soft">Connection</p>
                        <p className="mt-0.5 text-[11px] text-muted">
                          Re-authorize with {platformLabel(c.platform)} — needed yearly when
                          the refresh token expires, or after a new permission is added.
                          Your queue, history and name are kept.
                        </p>
                      </div>
                      <a
                        /* eslint-disable-next-line @next/next/no-html-link-for-pages */
                        href={oauthConnectPath(c.platform) as string}
                        className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface"
                      >
                        Reconnect
                      </a>
                    </div>
                  </div>
                ) : null}
                <ChannelName channelId={c.id} accountName={c.account_name} />
                <ChannelColor
                  channelId={c.id}
                  platform={c.platform}
                  accountName={c.account_name}
                  colorHue={c.color_hue}
                />

                <ChannelGroupSelect
                  channelId={c.id}
                  groupId={c.group_id}
                  groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                />

                {c.group_id === null ? (
                  <AutofillConfig
                    target={{ kind: "channel", id: c.id }}
                    enabled={c.autofill_enabled === 1}
                    cadenceConfig={c.cadence_config}
                    minQueueDepth={c.min_queue_depth}
                    targetQueueDepth={c.target_queue_depth}
                    reuseMinAgeDays={c.reuse_min_age_days}
                    bppEveryDays={c.bpp_every_days ?? 0}
                    bppPoolSize={getBppPool(c.id).usable}
                    bandTimes={config.bandTimes}
                    bandCounts={getBandCounts([c.id])}
                  />
                ) : (
                  <p className="mt-4 rounded-lg border border-border bg-surface-sunken/50 p-3 text-xs text-muted">
                    Auto-filled as part of{" "}
                    <span className="font-medium text-ink-soft">
                      {groupNames.get(c.group_id)}
                    </span>
                    . Its cadence is set on the group above.
                  </p>
                )}
              </div>
            ))}
          </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-faint">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
