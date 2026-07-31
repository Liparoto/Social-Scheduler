import { getChannels, listChannelGroups, getGroupMembers } from "@/lib/queries";
import { config } from "@/lib/config";
import { accountIdLabel, usesAccountId } from "@/lib/platforms";
import { PageHeader, ChannelChip, ChannelAvatar, EmptyState } from "@/components/ui";
import { ChannelForm } from "@/components/channel-form";
import { ChannelToggle } from "@/components/channel-toggles";
import { ChannelCredentials } from "@/components/channel-credentials";
import { ChannelAvatarRefresh } from "@/components/channel-avatar-refresh";
import { ChannelColor } from "@/components/channel-color";
import { ChannelTimezone } from "@/components/channel-timezone";
import { AutofillConfig } from "@/components/autofill-config";
import { ChannelGroups } from "@/components/channel-groups";
import { ChannelGroupSelect } from "@/components/channel-group-select";
import { tzAbbrev } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function ChannelsPage() {
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
    members: getGroupMembers(g.id).map((m) => ({
      id: m.id,
      account_name: m.account_name,
      platform: m.platform,
    })),
  }));
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));

  return (
    <div>
      <PageHeader
        title="Channels"
        subtitle="Each social account is configured independently — its own credentials, timezone, and rules."
      />

      <div className="px-8 py-6 space-y-6">
        <ChannelForm
          defaultTimezone={config.defaultTimezone}
          nextChannelId={channels.reduce((max, c) => Math.max(max, c.id), 0) + 1}
        />

        {channels.length === 0 ? (
          <EmptyState title="No channels configured">
            Add your first account above — Instagram, Facebook, Threads, Discord, or
            Telegram. Most need an account id and a long-lived access token; Discord
            just needs a webhook URL.
          </EmptyState>
        ) : (
          <>
          <ChannelGroups groups={groups} />
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
                      {usesAccountId(c.platform) ? (
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

                <ChannelTimezone channelId={c.id} timezone={c.timezone} />

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
