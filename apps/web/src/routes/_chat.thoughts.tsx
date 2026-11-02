import { THOUGHT_ID_PATTERN } from "@synara/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { ThoughtsPage } from "~/components/ThoughtsPage";

export const Route = createFileRoute("/_chat/thoughts")({
  validateSearch: (search: Record<string, unknown>): { entry?: string } =>
    typeof search.entry === "string" && new RegExp(THOUGHT_ID_PATTERN).test(search.entry)
      ? { entry: search.entry }
      : {},
  component: ThoughtsRoute,
});

function ThoughtsRoute() {
  const { entry } = Route.useSearch();
  return <ThoughtsPage entryId={entry} />;
}
