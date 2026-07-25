"use client";

import { COLOR_SWATCHES, channelColor } from "@/lib/format";

/**
 * Shared accent-colour picker for the channel create form and the channel edit panel.
 * `value` is the stored `color_hue` (null = "Automatic" = derive from the channel id,
 * today's behaviour). The selected swatch is never conveyed by colour alone — a ring
 * plus a check mark mark it, and every button carries its own accessible name so a
 * screen reader hears "Teal, selected" rather than just a hue number.
 */
export function ColorSwatchPicker({
  value,
  onChange,
  previewChannelId,
  previewName,
  previewPlatformLabel,
}: {
  value: number | null;
  onChange: (hue: number | null) => void;
  previewChannelId: number;
  previewName: string;
  previewPlatformLabel: string;
}) {
  const preview = channelColor(previewChannelId, value);

  return (
    <div>
      <div role="group" aria-label="Accent colour" className="flex flex-wrap items-center gap-2">
        <SwatchButton
          selected={value === null}
          onClick={() => onChange(null)}
          label="Automatic (default colour for this channel)"
        >
          <span className="text-[10px] font-semibold text-ink-soft">A</span>
        </SwatchButton>
        {COLOR_SWATCHES.map((s) => (
          <SwatchButton
            key={s.hue}
            selected={value === s.hue}
            onClick={() => onChange(s.hue)}
            label={s.name}
            swatchColor={`hsl(${s.hue} 60% 45%)`}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <span>Preview:</span>
        <span
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
          style={{ color: preview.fg, backgroundColor: preview.bg }}
        >
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: preview.dot }} aria-hidden />
          {previewName || "Preview"}
          <span className="text-[10px] uppercase tracking-wide opacity-60">
            {previewPlatformLabel}
          </span>
        </span>
      </div>
    </div>
  );
}

function SwatchButton({
  selected,
  onClick,
  label,
  swatchColor,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  swatchColor?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={selected ? `${label}, selected` : label}
      title={label}
      onClick={onClick}
      className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
        selected ? "border-ink" : "border-border"
      }`}
      style={{ backgroundColor: swatchColor ?? "var(--color-surface-sunken)" }}
    >
      {children}
      {selected ? (
        <span
          aria-hidden
          className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-ink text-[8px] font-bold text-surface"
        >
          ✓
        </span>
      ) : null}
    </button>
  );
}
