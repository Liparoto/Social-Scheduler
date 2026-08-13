"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeControls } from "@/components/theme-controls";
import { UpdateBanner } from "@/components/update-banner";

const NAV = [
  { href: "/", label: "Overview", hint: "Queue & status" },
  { href: "/calendar", label: "Calendar", hint: "Week & month view" },
  { href: "/compose", label: "Compose", hint: "New post" },
  { href: "/import", label: "Import", hint: "Bulk add images" },
  { href: "/library", label: "Library", hint: "Posts & bulk schedule" },
  { href: "/insights", label: "Insights", hint: "How accounts perform" },
  { href: "/insights/pool", label: "BPP Pool", hint: "Posts worth repeating" },
  { href: "/media", label: "Media", hint: "Stored files & cleanup" },
  { href: "/periods", label: "Periods", hint: "In-season windows" },
  { href: "/tags", label: "Tags", hint: "Topics & cleanup" },
  { href: "/channels", label: "Channels", hint: "Accounts & config" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    // sticky + self-start + h-screen: as a flex child it would otherwise stretch to the
    // full page height, and a stretched box has nothing to stick within. Pinned to one
    // viewport with its own scrollbar, so long pages scroll the content, not the nav.
    <aside className="sticky top-0 self-start h-screen w-60 shrink-0 overflow-y-auto border-r border-border bg-surface flex flex-col">
      <div className="px-5 py-6 border-b border-border">
        <div className="flex items-center gap-2.5">
          <span
            className="inline-block h-6 w-6 rounded-md bg-brand"
            aria-hidden
            style={{
              backgroundImage:
                "linear-gradient(135deg, var(--color-brand) 40%, var(--color-accent))",
            }}
          />
          <span className="font-display text-[15px] font-semibold tracking-tight text-ink">
            SocialScheduler
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-tight text-faint">
          Self-hosted · local only
        </p>
      </div>

      <nav className="flex-1 p-3">
        <ul className="space-y-1">
          {NAV.map((item) => {
            // Exact match for /insights so the nested "BPP pool" page does not light up
            // its parent as well — two highlighted rows reads as a bug.
            const active =
              item.href === "/" || item.href === "/insights"
                ? pathname === item.href
                : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block rounded-lg px-3 py-2 transition-colors ${
                    active
                      ? "bg-brand-weak text-brand-strong"
                      : "text-ink-soft hover:bg-surface-sunken"
                  }`}
                >
                  <span className="block text-sm font-medium">{item.label}</span>
                  <span className="block text-[11px] text-muted">{item.hint}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="p-3 border-t border-border space-y-3">
        <UpdateBanner />
        <ThemeControls />
        <p className="px-3 text-[11px] leading-relaxed text-faint">
          Worker runs separately.
          <br />
          Safety switches live in{" "}
          <code className="data text-[10px] text-muted">.env</code>.
        </p>
      </div>
    </aside>
  );
}
