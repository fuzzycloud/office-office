import { createFileRoute } from "@tanstack/react-router";
import { refreshOnEntry, sourceSearch } from "../route-context";
export const Route = createFileRoute("/projects")({
	validateSearch: sourceSearch,
	beforeLoad: ({ context }) =>
		refreshOnEntry(context.queryClient, [
			["task-discussion"],
			["task-reports"],
			["report"],
			["project-discussion"],
		]),
});
