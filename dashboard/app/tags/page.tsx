import { listTags, listTopicTagsWithUsage } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import { TagManager } from "@/components/tag-manager";

export const dynamic = "force-dynamic";

export default function TagsPage() {
  const topicTags = listTopicTagsWithUsage();
  const bandTags = listTags("time_of_day");
  // The picker orders the bands this way too — alphabetical would read as arbitrary.
  const bandOrder = ["morning", "afternoon", "evening", "anytime"];
  const bands = [...bandTags].sort(
    (a, b) => bandOrder.indexOf(a.name) - bandOrder.indexOf(b.name)
  );

  return (
    <div>
      <PageHeader
        title="Tags"
        subtitle="Every label in this install. Rename a topic to fix it everywhere, or delete it to take it off the posts that carry it — the posts stay either way."
      />
      <div className="px-8 py-6">
        <TagManager topicTags={topicTags} bandTags={bands} />
      </div>
    </div>
  );
}
