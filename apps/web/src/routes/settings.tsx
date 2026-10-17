import { createFileRoute } from "@tanstack/react-router";
import { refreshOnEntry, sourceSearch } from "../route-context";
export const Route = createFileRoute("/settings")({
	validateSearch: sourceSearch,
	beforeLoad: ({ context }) =>
		refreshOnEntry(context.queryClient, [["agent-keys"]]),
});
