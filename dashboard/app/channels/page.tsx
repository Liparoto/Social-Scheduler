import { getChannels } from "@/lib/queries";
import { config } from "@/lib/config";
import { accountIdLabel, usesAccountId } from "@/lib/platforms";
import { PageHeader, ChannelChip, EmptyState } from "@/components/ui";
import { ChannelForm } from "@/components/channel-form";
import { ChannelToggle } from "@/components/channel-toggles";
import { ChannelCredentials } from "@/components/channel-credentials";
import { ChannelColor } from "@/components/channel-color";
import { AutofillConfig } from "@/components/autofill-config";
import { tzAbbrev } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function ChannelsPage() {
  const channels = getChannels();

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
          <div className="grid gap-4 md:grid-cols-2">
            {channels.map((c) => (
              <div
                key={c.id}
                className={`rounded-card border bg-surface p-5 ${
                  c.is_active ? "border-border" : "border-border opacity-60"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <ChannelChip id={c.id} platform={c.platform} name={c.account_name} colorHue={c.color_hue} />
                    {c.business_label ? (
                      <p className="mt-1.5 text-xs text-muted">{c.business_label}</p>
                    ) : null}
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

                <ChannelColor
                  channelId={c.id}
                  platform={c.platform}
                  accountName={c.account_name}
                  colorHue={c.color_hue}
                />

                <AutofillConfig
                  channelId={c.id}
                  enabled={c.autofill_enabled === 1}
                  cadenceConfig={c.cadence_config}
                  minQueueDepth={c.min_queue_depth}
                  targetQueueDepth={c.target_queue_depth}
                  reuseMinAgeDays={c.reuse_min_age_days}
                />
              </div>
            ))}
          </div>
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
