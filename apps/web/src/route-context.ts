import type { QueryClient } from "@tanstack/react-query";
export type RouterContext = { queryClient: QueryClient };

export async function refreshOnEntry(
	queryClient: QueryClient,
	extraKeys: string[][] = [],
) {
	await Promise.all(
		[["workspace"], ...extraKeys].map((queryKey) =>
			queryClient.invalidateQueries({ queryKey, refetchType: "active" }),
		),
	);
}

// Only bounded, known source selectors cross a navigation boundary.
export function sourceSearch(search: Record<string, unknown>): {
	sourceKind?: string;
	sourceId?: string;
	revision?: number;
} {
	return {
		sourceKind:
			typeof search.sourceKind === "string"
				? search.sourceKind.slice(0, 40)
				: undefined,
		sourceId:
			typeof search.sourceId === "string"
				? search.sourceId.slice(0, 200)
				: undefined,
		revision:
			Number.isSafeInteger(Number(search.revision)) &&
			Number(search.revision) > 0
				? Number(search.revision)
				: undefined,
	};
}
