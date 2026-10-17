import {
	createRootRouteWithContext,
	Link,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import App from "../App";
import type { RouterContext } from "../route-context";

const sectionPaths = new Set([
	"/",
	"/team",
	"/notifications",
	"/customers",
	"/projects",
	"/reports",
	"/files",
	"/roles",
	"/social",
	"/settings",
]);
function RootPage() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	return sectionPaths.has(pathname.replace(/\/+$/, "") || "/") ? (
		<App />
	) : (
		<Outlet />
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
export const Route = createRootRouteWithContext<RouterContext>()({
	component: RootPage,
	notFoundComponent: NotFound,
});
