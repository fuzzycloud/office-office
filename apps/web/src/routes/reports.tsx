import { createFileRoute } from "@tanstack/react-router";
import { refreshOnEntry, sourceSearch } from "../route-context";
export const Route = createFileRoute("/reports")({
	validateSearch: sourceSearch,
	beforeLoad: ({ context }) =>
		refreshOnEntry(context.queryClient, [
			["reports"],
			["report"],
			["report-reviews"],
		]),
});
