import { createFileRoute } from "@tanstack/react-router";
import { refreshOnEntry, sourceSearch } from "../route-context";
export const Route = createFileRoute("/files")({
	validateSearch: sourceSearch,
	beforeLoad: ({ context }) => refreshOnEntry(context.queryClient, [["files"]]),
});
