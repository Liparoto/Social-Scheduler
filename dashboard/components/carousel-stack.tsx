import type { ReactNode } from "react";

/**
 * The "stack of paper" treatment that makes a carousel recognisable in the Library at a
 * glance, without reading text.
 *
 * The layers are empty elements, not thumbnails. Rendering slides 2 and 3 for real would
 * look better and would triple the Library's image requests — a few hundred extra fetches
 * on every load of a list whose whole job is to be skimmed.
 *
 * This wraps AROUND the thumbnail's container rather than sitting inside it: that
 * container is overflow-hidden, so layers placed within it would be clipped to exactly
 * the thumbnail's bounds and never seen.
 */
// `children` is typed optional purely to satisfy React.createElement's overload resolution:
// createElement's props-argument overload requires every required prop to be present in
// that argument even when children are supplied as trailing rest args (as the ui test does),
// so a required `children` here fails to typecheck at every call site that isn't JSX. Every
// real caller (JSX in library-view.tsx) always supplies it.
export function CarouselStack({ count, children }: { count: number; children?: ReactNode }) {
  if (count <= 1) return <>{children}</>;

  return (
    <div className="relative shrink-0">
      <span
        aria-hidden
        className="absolute left-1.5 top-1.5 h-full w-full rounded-md border border-border bg-surface-sunken"
      />
      <span
        aria-hidden
        className="absolute left-0.5 top-0.5 h-full w-full rounded-md border border-border bg-surface"
      />
      {/* Positioned so it paints above the two layers, which are absolute and would
          otherwise sit on top of the (unpositioned) thumbnail. */}
      <div className="relative">{children}</div>
      <span className="data absolute -right-1 -top-1 z-10 rounded-full bg-ink px-1.5 py-px text-[10px] font-medium text-surface">
        <span aria-hidden>{count}</span>
        <span className="sr-only">{count} slides</span>
      </span>
    </div>
  );
}
