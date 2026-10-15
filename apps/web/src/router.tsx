import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Link,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import App from "./App";

type RouterContext = { queryClient: QueryClient };

async function refreshOnEntry(
	queryClient: QueryClient,
	extraKeys: string[][] = [],
) {
	await Promise.all(
		[["workspace"], ...extraKeys].map((queryKey) =>
			queryClient.invalidateQueries({ queryKey, refetchType: "active" }),
		),
	);
}

function NotFound() {
	return (
		<main className="grid min-h-screen place-content-center gap-4 bg-base-200 p-6 text-center">
			<h1 className="text-3xl font-semibold">Page not found</h1>
			<p className="text-base-content/70">
				This office section does not exist.
			</p>
			<Link to="/" className="btn btn-primary">
				Return to overview
			</Link>
		</main>
	);
}

const sectionPaths = new Set([
	"/",
	"/team",
	"/customers",
	"/projects",
	"/reports",
	"/roles",
	"/social",
	"/settings",
]);

function RootPage() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const path = pathname.replace(/\/+$/, "") || "/";
	return sectionPaths.has(path) ? <App /> : <Outlet />;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
	component: RootPage,
	notFoundComponent: NotFound,
});

const overviewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	beforeLoad: ({ context }) => refreshOnEntry(context.queryClient),
});
const teamRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "team",
	beforeLoad: ({ context }) => refreshOnEntry(context.queryClient),
});
const customersRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "customers",
	beforeLoad: ({ context }) => refreshOnEntry(context.queryClient),
});
const projectsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "projects",
	beforeLoad: ({ context }) =>
		refreshOnEntry(context.queryClient, [
			["task-discussion"],
			["task-reports"],
			["report"],
		]),
});
const reportsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "reports",
	beforeLoad: ({ context }) =>
		refreshOnEntry(context.queryClient, [["reports"], ["report"]]),
});
const rolesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "roles",
	beforeLoad: ({ context }) => refreshOnEntry(context.queryClient, [["roles"]]),
});
const socialRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "social",
	beforeLoad: ({ context }) => refreshOnEntry(context.queryClient),
});
const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "settings",
	beforeLoad: ({ context }) =>
		refreshOnEntry(context.queryClient, [["agent-keys"]]),
});

const routeTree = rootRoute.addChildren([
	overviewRoute,
	teamRoute,
	customersRoute,
	projectsRoute,
	reportsRoute,
	rolesRoute,
	socialRoute,
	settingsRoute,
]);

export function makeRouter(queryClient: QueryClient) {
	return createRouter({ routeTree, context: { queryClient } });
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof makeRouter>;
	}
}
