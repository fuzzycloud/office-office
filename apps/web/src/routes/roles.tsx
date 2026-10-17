import { createFileRoute } from "@tanstack/react-router";
import { refreshOnEntry, sourceSearch } from "../route-context";
export const Route = createFileRoute("/roles")({
	validateSearch: sourceSearch,
	beforeLoad: ({ context }) => refreshOnEntry(context.queryClient, [["roles"]]),
});
