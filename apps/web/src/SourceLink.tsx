import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { resolveSource } from "./api";
import { sourceHref } from "./ConversationFields";

export default function SourceLink({
	kind,
	id,
	revision = 0,
	children,
	className = "link text-sm",
	onClick,
}: {
	kind: string;
	id: string;
	revision?: number;
	children: ReactNode;
	className?: string;
	onClick?: () => void;
}) {
	const direct = [
		"task",
		"project",
		"report",
		"file",
		"customer",
		"member",
	].includes(kind);
	const query = useQuery({
		queryKey: ["source-context", kind, id, revision],
		queryFn: () => resolveSource(kind, id, revision),
		enabled: !direct,
		retry: false,
	});
	let href = direct
		? sourceHref(kind, id, revision) +
			(["customer", "member"].includes(kind) ? `#source-${kind}-${id}` : "")
		: "";
	const context = query.data;
	if (context) {
		if (context.kind === "board") href = sourceHref("board", context.id);
		else if (context.module === "reports" && context.reportId)
			href = sourceHref(
				"report",
				context.reportId,
				context.reportRevision ||
					(context.kind === "report" ? context.revision : 0),
			);
		else if (context.kind === "project_message" && context.projectId)
			href = sourceHref("project", context.projectId);
		else if (context.taskId) href = sourceHref("task", context.taskId);
		else if (context.projectId) href = sourceHref("project", context.projectId);
		else if (context.module)
			href = `/${context.module === "team" ? "team" : context.module}?${new URLSearchParams({ sourceKind: context.kind, sourceId: context.id })}`;
		if (href) href += `#source-${context.kind}-${context.id}`;
	}
	if (!href)
		return (
			<span className="text-sm text-base-content/65">
				{query.isError
					? "Source unavailable"
					: query.isPending
						? "Loading source…"
						: children}
			</span>
		);
	return (
		<a className={className} href={href} onClick={onClick}>
			{children}
		</a>
	);
}

export function useSourceAnchor(data: unknown) {
	useEffect(() => {
		if (!data || !window.location.hash.startsWith("#source-")) return;
		const frame = requestAnimationFrame(() => {
			let anchor: string;
			try {
				anchor = decodeURIComponent(window.location.hash.slice(1));
			} catch {
				return;
			}
			const element = document.getElementById(anchor);
			if (element) {
				element.setAttribute("tabindex", "-1");
				element.scrollIntoView({ block: "center" });
				element.focus({ preventScroll: true });
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [data]);
}
