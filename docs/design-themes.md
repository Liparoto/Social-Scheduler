# Design — Theme system (7 families × light/dark)

**Status:** approved-approach 2026-07-23, pending spec review
**Part of:** dashboard visual layer. Net-new subsystem — SocialScheduler currently has **no**
theming/dark-mode mechanism at all.

---

## 1. Purpose

Add a switchable theme system to the dashboard. Seven theme **families** — the existing
SocialScheduler "control room" palette plus five imported from the APT Analytics project
(Claude/modern, APT, FYZICAL, Default, Solarized) and one new **Vela** family built from the Vela
Event Design brand guide. Each family ships a **light** and a **dark** variant (14 palettes total),
selectable via a family picker + a sun/moon mode toggle, persisted locally.

**Why this shape:** the source APT themes are written against a shadcn/ui token contract (30 tokens:
`--background`, `--primary`, `--card`, `--sidebar-*`, `--chart-*`). SocialScheduler uses its own
bespoke "publishing control room" vocabulary (`--color-canvas`, `--color-ink`, `--color-brand`,
`--color-accent`, `--color-status-*`). The source palettes therefore cannot be pasted in — each is
**translated** into SocialScheduler's own 20-token contract. Because the whole dashboard already
renders through those `--color-*` tokens (Tailwind v4 `@theme`), redefining the tokens per theme
re-themes every screen automatically.

---

## 2. Architecture

### 2.1 Attributes + CSS structure

The active theme is expressed as two attributes on `<html>`:

```html
<html data-theme="claude" data-mode="dark">
```

- `data-theme` — the family (`socialscheduler` | `claude` | `apt` | `fyzical` | `default` |
  `solarized` | `vela`).
- `data-mode` — `light` | `dark`.

`dashboard/app/globals.css` keeps the current `@theme { … }` block **but its `--color-*` values
become the fallback/default** (SocialScheduler light). Each of the other 13 palettes is a plain CSS
block that overrides those variables:

```css
html[data-theme="claude"][data-mode="light"] { --color-canvas: #faf9f5; /* …20 tokens… */ }
html[data-theme="claude"][data-mode="dark"]  { --color-canvas: #1a1716; /* … */ }
/* …one block per (family, mode)… */
```

No change to the `@theme` mapping is needed — Tailwind v4 already generates `bg-surface`,
`text-ink`, `border-border`, `text-status-posted`, etc. from those variable names; overriding the
variable value at the `html[...]` level cascades to every utility. Fonts, `--radius-card`, the
`.data` utility, focus ring, and reduced-motion rules stay in `:root`/`body` unchanged.

**Selector specificity note:** the `@theme` block emits `:root`-level variables (specificity 0,1,0).
`html[data-theme][data-mode]` is 0,2,1 and always wins, so the default block and the override blocks
never fight. All override blocks share equal specificity; the last-matching one per (theme,mode)
applies — they are mutually exclusive by attribute, so order is irrelevant.

### 2.2 Persistence + no-flash

Local-only install, no DB/auth — persistence is **`localStorage`**, not cookies+Supabase (that is
how APT does it; it does not fit this architecture). Two keys: `ss-theme`, `ss-mode`.

To avoid a flash of the default theme before hydration, a tiny **blocking inline script** runs in
`<head>` (via `layout.tsx`, `dangerouslySetInnerHTML`) and sets the attributes before first paint:

```js
(function(){try{
  var t=localStorage.getItem('ss-theme')||'socialscheduler';
  var m=localStorage.getItem('ss-mode')||'light';
  var d=document.documentElement;
  d.setAttribute('data-theme',t); d.setAttribute('data-mode',m);
}catch(e){}})();
```

The server render sets the defaults statically (`data-theme="socialscheduler" data-mode="light"`) so
there is a valid SSR state; the script corrects it pre-paint. This is a read of a client-only value,
so `suppressHydrationWarning` goes on `<html>`.

### 2.3 Controls

A single client component `dashboard/components/theme-controls.tsx`, mounted in the **sidebar footer**
(`components/sidebar.tsx` is already `"use client"`):

- **Family `<select>`** — 7 options, labels from a small `THEMES` catalog constant.
- **Mode toggle button** — sun/moon; flips `data-mode` within the current family.

On change it (a) sets the attribute on `document.documentElement`, (b) writes the matching
`localStorage` key. No server round-trip, no `revalidate`. Reads initial state from the attributes
already on `<html>` (set by the no-flash script) so the control matches what is shown.

A `THEMES` catalog (`dashboard/lib/themes.ts`) holds `{ id, label }[]` and the two mode ids — the
single source of truth for the picker and for validation of the persisted value (unknown id → fall
back to `socialscheduler`/`light`).

### 2.4 Files touched

| File | Change |
|---|---|
| `dashboard/app/globals.css` | Add 13 palette override blocks + shared light/dark status blocks |
| `dashboard/lib/themes.ts` | **New** — `THEMES` catalog, ids, defaults, `isThemeId`/`isMode` guards |
| `dashboard/components/theme-controls.tsx` | **New** — client family select + mode toggle |
| `dashboard/components/sidebar.tsx` | Mount `<ThemeControls/>` in the footer block |
| `dashboard/app/layout.tsx` | Static default attrs on `<html>` + no-flash `<head>` script + `suppressHydrationWarning` |

No schema, migration, worker, or route-handler change. Nothing written to `/data`. No new dependency
(no `next-themes` — the mechanism is ~30 lines and fits local-only better).

---

## 3. The 20-token contract

Every palette defines exactly these (the variables the dashboard already consumes):

| Group | Tokens |
|---|---|
| Surfaces | `--color-canvas` `--color-surface` `--color-surface-sunken` `--color-border` `--color-border-strong` |
| Text | `--color-ink` `--color-ink-soft` `--color-muted` `--color-faint` |
| Brand (identity) | `--color-brand` `--color-brand-ink` `--color-brand-weak` |
| Accent (primary CTA) | `--color-accent` `--color-accent-ink` `--color-accent-weak` |
| Status (semantic) | `--color-status-draft` `--color-status-scheduled` `--color-status-posted` `--color-status-failed` `--color-status-publishing` |

**Token meanings** (so translations stay faithful):
- `canvas` page bg · `surface` panel/card bg · `surface-sunken` inset/hover/input bg.
- `border` hairlines · `border-strong` emphasized dividers.
- `ink` primary text · `ink-soft` secondary text · `muted` labels/meta · `faint` placeholders/disabled.
- `brand` identity color (logo, active nav) · `brand-ink` brand-colored text readable **on
  `brand-weak`** (darker in light mode, lighter in dark mode) · `brand-weak` tinted brand background.
- `accent` primary-CTA color ("Post now") · `accent-ink` accent text on `accent-weak` · `accent-weak`
  tinted accent background. Same on-tint direction rule as brand.

**Mapping from source (shadcn) → SS:** `background→canvas`, `card→surface`, `muted→surface-sunken`,
`border→border`, `foreground→ink`, `muted-foreground→muted`, `primary→brand`. `ink-soft`, `faint`,
`border-strong`, and every `*-ink` / `*-weak` tint are **derived** (a measured lighten/darken of the
mapped color) so each palette is complete and internally consistent even though the source contract
was different.

**Accent policy (per family):** SocialScheduler's signature is *brand = identity, accent = the CTA
that pops*. Preserve a distinct accent where the source has a natural second color; collapse to
single-accent (accent = brand) where the family is intentionally mono/warm, rather than invent a
color that fights the palette. Per-family choice is recorded in §5.

---

## 4. Shared status colors

Status semantics must be unmistakable on **every** theme, so status colors are **not** per-family.
Two shared sets — one per mode — reused across all families:

```css
/* light status (identical to today's values → the default theme is visually unchanged) */
--color-status-draft:#64748b; --color-status-scheduled:#2563eb; --color-status-posted:#0e5c4a;
--color-status-failed:#dc2626; --color-status-publishing:#b45309;

/* dark status (brightened for legibility on dark canvases) */
--color-status-draft:#94a3b8; --color-status-scheduled:#60a5fa; --color-status-posted:#34d399;
--color-status-failed:#f87171; --color-status-publishing:#fbbf24;
```

Implementation: emit these as two blocks keyed on `data-mode` only —
`html[data-mode="light"]{…}` / `html[data-mode="dark"]{…}` — placed **before** the per-family blocks
so a family block *could* override a status token later if ever needed (none do in v1). Per-family
status overrides are explicitly out of scope for v1.

---

## 5. The 14 palettes

Status tokens are the §4 shared sets and are omitted from the tables below. Values are the
authored/derived SS tokens.

### 5.1 SocialScheduler — pine + signal-orange (dual accent). *default family.*

Light = the current palette, verbatim (no visual change). Dark = newly authored.

| token | light | dark |
|---|---|---|
| canvas | `#f5f6f8` | `#0f1417` |
| surface | `#ffffff` | `#161d22` |
| surface-sunken | `#eef0f3` | `#1e262c` |
| border | `#e4e7ec` | `#2a333b` |
| border-strong | `#d3d8e0` | `#3a454e` |
| ink | `#161b22` | `#e8ecf0` |
| ink-soft | `#37414f` | `#c2cad2` |
| muted | `#656c76` | `#8b95a1` |
| faint | `#9aa2ad` | `#5f6975` |
| brand | `#0e5c4a` | `#2aa88a` |
| brand-ink | `#0a4437` | `#6fd3b8` |
| brand-weak | `#e2efe9` | `#14352c` |
| accent | `#f0653a` | `#f0653a` |
| accent-ink | `#c94a22` | `#ff8b63` |
| accent-weak | `#fdeae2` | `#3a2019` |

### 5.2 Claude — cream + terracotta (single accent = terracotta).

| token | light | dark |
|---|---|---|
| canvas | `#faf9f5` | `#1a1716` |
| surface | `#ffffff` | `#2d2724` |
| surface-sunken | `#efece1` | `#3a322d` |
| border | `#ddd9c8` | `#423a34` |
| border-strong | `#cfc9b4` | `#55483f` |
| ink | `#141413` | `#faf9f5` |
| ink-soft | `#3d3a34` | `#d9d4cb` |
| muted | `#5a564c` | `#b0aea5` |
| faint | `#8a857a` | `#837e75` |
| brand | `#d97757` | `#e08a68` |
| brand-ink | `#b85e40` | `#f0a988` |
| brand-weak | `#f6e7df` | `#3a2a22` |
| accent | `#d97757` | `#e08a68` |
| accent-ink | `#b85e40` | `#f0a988` |
| accent-weak | `#f6e7df` | `#3a2a22` |

### 5.3 APT — parchment/navy + reflective gold (single accent = gold).

| token | light | dark |
|---|---|---|
| canvas | `#f7f4e8` | `#1a1c3e` |
| surface | `#ffffff` | `#292c5f` |
| surface-sunken | `#efe9d4` | `#353a78` |
| border | `#d8ceac` | `#3a3f7a` |
| border-strong | `#c9bd94` | `#4a4f90` |
| ink | `#292c5f` | `#f4e9c7` |
| ink-soft | `#454880` | `#d8cfa8` |
| muted | `#6f5e22` | `#bfae7b` |
| faint | `#9a8a55` | `#8a805c` |
| brand | `#b2973d` | `#cbb04e` |
| brand-ink | `#8a7530` | `#e6cf7a` |
| brand-weak | `#efe6c9` | `#38321c` |
| accent | `#b2973d` | `#cbb04e` |
| accent-ink | `#8a7530` | `#e6cf7a` |
| accent-weak | `#efe6c9` | `#38321c` |

> Optional extra (deferred, §7): APT's brushed-gold gradient button treatment.

### 5.4 FYZICAL — sky blue + navy (single accent = sky).

| token | light | dark |
|---|---|---|
| canvas | `#f4f8fb` | `#0c1a2e` |
| surface | `#ffffff` | `#142844` |
| surface-sunken | `#eaf2f9` | `#1b365d` |
| border | `#d5dee9` | `#274263` |
| border-strong | `#c2cfde` | `#345177` |
| ink | `#1b365d` | `#e6f4fb` |
| ink-soft | `#34517a` | `#bcd6ec` |
| muted | `#4a6480` | `#9fc2e0` |
| faint | `#8298b2` | `#6b89a8` |
| brand | `#0091da` | `#35abe6` |
| brand-ink | `#0073ad` | `#71c5e8` |
| brand-weak | `#e6f4fb` | `#10314f` |
| accent | `#0091da` | `#35abe6` |
| accent-ink | `#0073ad` | `#71c5e8` |
| accent-weak | `#e6f4fb` | `#10314f` |

### 5.5 Default — warm-neutral / charcoal grayscale (single accent = mono).

Source is `oklch()`; converted to hex to match the file's style. Dark is intentionally monochrome
(near-white brand used as a solid button bg with dark `brand-ink` text — verify contrast in browser).

| token | light | dark |
|---|---|---|
| canvas | `#f7f3ec` | `#1c1c1c` |
| surface | `#fdfcfa` | `#212121` |
| surface-sunken | `#ece6db` | `#2b2b2b` |
| border | `#ddd6c7` | `#333333` |
| border-strong | `#cec6b3` | `#444444` |
| ink | `#322e28` | `#fafafa` |
| ink-soft | `#524b40` | `#d4d4d4` |
| muted | `#736a5c` | `#adadad` |
| faint | `#a39a89` | `#6f6f6f` |
| brand | `#453a2e` | `#e6e6e6` |
| brand-ink | `#2f271e` | `#1c1c1c` |
| brand-weak | `#e8e1d3` | `#2f2f2f` |
| accent | `#453a2e` | `#e6e6e6` |
| accent-ink | `#2f271e` | `#1c1c1c` |
| accent-weak | `#e8e1d3` | `#2f2f2f` |

### 5.6 Solarized — Ethan Schoonover palette (dual accent: blue brand + orange CTA).

| token | light | dark |
|---|---|---|
| canvas | `#fdf6e3` | `#002b36` |
| surface | `#fffdf5` | `#073642` |
| surface-sunken | `#eee8d5` | `#094352` |
| border | `#e3dcc4` | `#0e4b5a` |
| border-strong | `#d5cdb0` | `#145868` |
| ink | `#586e75` | `#93a1a1` |
| ink-soft | `#657b83` | `#839496` |
| muted | `#839496` | `#657b83` |
| faint | `#93a1a1` | `#586e75` |
| brand | `#268bd2` | `#268bd2` |
| brand-ink | `#1e6fa8` | `#6fb8e8` |
| brand-weak | `#d9ebf7` | `#0a3a4a` |
| accent | `#cb4b16` | `#cb4b16` |
| accent-ink | `#a53d12` | `#e0692f` |
| accent-weak | `#f6e0d3` | `#3a2013` |

### 5.7 Vela — Vela Event Design brand (light: dual, coastal brand + graphite CTA; dark: single coastal).

Built from `SKILL.md`: Floral White `#FFFAF0`, Graphite `#32312E`, Coastal Blue `#738B9C`,
Dark Khaki `#554C3A`, Pale Sky `#C2D0D4`, Ash Grey `#D0DCD4`. Fonts (Cormorant Garamond / Arial) are
**not** applied in v1 — see §7.

| token | light | dark |
|---|---|---|
| canvas | `#fffaf0` | `#32312e` |
| surface | `#ffffff` | `#3d3b37` |
| surface-sunken | `#f3eee1` | `#454340` |
| border | `#e3ddce` | `#4f4c47` |
| border-strong | `#d4ccba` | `#605c56` |
| ink | `#32312e` | `#fffaf0` |
| ink-soft | `#554c3a` | `#ded8cb` |
| muted | `#6f665a` | `#b3a89a` |
| faint | `#9a9384` | `#837c6e` |
| brand | `#738b9c` | `#8ba3b4` |
| brand-ink | `#5a7183` | `#a9bfcd` |
| brand-weak | `#dfe7ea` | `#3a4650` |
| accent | `#32312e` | `#8ba3b4` |
| accent-ink | `#554c3a` | `#a9bfcd` |
| accent-weak | `#e9e5dc` | `#3a4650` |

---

## 6. Correctness / UX

- **No data/schema/worker change** — pure presentation layer over existing tokens.
- **Default theme unchanged:** SocialScheduler-light values are copied verbatim and are the SSR
  default, so a fresh install looks exactly as it does today until the user picks another theme.
- **No FOUC:** the blocking `<head>` script sets attributes before paint; `suppressHydrationWarning`
  prevents a mismatch warning for the client-only value.
- **Status legibility:** shared per-mode status sets keep failed/posted/scheduled unmistakable on
  every palette.
- **Local-only fit:** localStorage only; nothing hits the DB or the worker; no cookies.
- **Quality floor:** existing focus-visible ring and reduced-motion rules are theme-agnostic and
  remain. The mode toggle is a real `<button>` with an accessible label; the family picker is a
  labeled `<select>`.

---

## 7. Verification

- `cd dashboard && npx tsc --noEmit` clean.
- Browser: cycle all 7 families in both modes. For each, confirm canvas/surface/ink/border render,
  brand-active nav pill is legible, an accent CTA is legible, and the status badges read correctly.
  Spot-check the two contrast-risk cases called out above: **Default-dark** (near-white brand button)
  and **Vela-light** (graphite accent). Reload to confirm persistence + no flash. Confirm the toggle
  flips mode within the family and the select changes family while keeping mode.

---

## 8. Out of scope (deferred)

- **Per-theme fonts** (e.g. Vela's Cormorant Garamond + Arial, Claude's font identity). v1 keeps
  SocialScheduler's Space Grotesk / Inter / JetBrains-Mono across all themes. Clean fast-follow.
- **APT brushed-gold gradient button** treatment (a per-family button style rule beyond tokens).
- **Per-family status color overrides.**
- **Syncing theme to the worker or any file in `/data`.** Themes are dashboard-only presentation.
- **A settings page** for themes (the sidebar footer control is sufficient for an internal tool).
