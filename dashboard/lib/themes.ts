export type ThemeId =
  | "socialscheduler"
  | "claude"
  | "apt"
  | "fyzical"
  | "default"
  | "solarized"
  | "vela";

export type ThemeMode = "light" | "dark";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "socialscheduler", label: "SocialScheduler" },
  { id: "claude", label: "Claude" },
  { id: "apt", label: "APT" },
  { id: "fyzical", label: "FYZICAL" },
  { id: "default", label: "Default" },
  { id: "solarized", label: "Solarized" },
  { id: "vela", label: "Vela" },
];

export const DEFAULT_THEME: ThemeId = "socialscheduler";
export const DEFAULT_MODE: ThemeMode = "light";

export const THEME_STORAGE_KEY = "ss-theme";
export const MODE_STORAGE_KEY = "ss-mode";

const THEME_IDS = new Set<string>(THEMES.map((t) => t.id));

export function isThemeId(v: string | null): v is ThemeId {
  return v !== null && THEME_IDS.has(v);
}

export function isMode(v: string | null): v is ThemeMode {
  return v === "light" || v === "dark";
}
