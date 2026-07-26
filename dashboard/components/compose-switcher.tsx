"use client";

import { useState } from "react";
import type { Period, Tag } from "@/lib/types";
import type { PublishReadiness } from "@/lib/publish-readiness";
import { Composer } from "./composer";
import { ScheduleFromLibrary, type LibraryPickItem, type ChannelLite } from "./schedule-from-library";

const segBtn = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-brand-weak font-medium text-brand-strong" : "text-muted hover:text-ink"
  }`;

export function ComposeSwitcher({
  channels,
  defaultTimezone,
  periods,
  timeOfDayTags,
  topicTags,
  libraryPosts,
  defaultDate,
  defaultTime,
  readiness,
}: {
  channels: ChannelLite[];
  defaultTimezone: string;
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  libraryPosts: LibraryPickItem[];
  defaultDate: string;
  defaultTime: string;
  readiness: PublishReadiness;
}) {
  const [mode, setMode] = useState<"new" | "library">("new");
  return (
    <div className="space-y-6">
      <div className="inline-flex rounded-lg border border-border p-0.5">
        <button type="button" className={segBtn(mode === "new")} onClick={() => setMode("new")}>New post</button>
        <button type="button" className={segBtn(mode === "library")} onClick={() => setMode("library")}>From library</button>
      </div>
      {mode === "new" ? (
        <Composer
          channels={channels}
          defaultTimezone={defaultTimezone}
          periods={periods}
          timeOfDayTags={timeOfDayTags}
          topicTags={topicTags}
          readiness={readiness}
        />
      ) : (
        <ScheduleFromLibrary
          posts={libraryPosts}
          channels={channels}
          defaultDate={defaultDate}
          defaultTime={defaultTime}
        />
      )}
    </div>
  );
}
