"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Overview", hint: "Queue & status" },
  { href: "/compose", label: "Compose", hint: "New post" },
  { href: "/channels", label: "Channels", hint: "Accounts & config" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 shrink-0 border-r border-border bg-surface flex flex-col">
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
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block rounded-lg px-3 py-2 transition-colors ${
                    active
                      ? "bg-brand-weak text-brand-ink"
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

      <div className="p-3 border-t border-border">
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
