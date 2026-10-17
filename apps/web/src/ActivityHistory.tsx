import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listActivity, type Workspace } from "./api";
import MemberAvatar from "./MemberAvatar";
import SourceLink from "./SourceLink";

export default function ActivityHistory({
	workspace,
}: {
	workspace: Workspace;
}) {
	const [offset, setOffset] = useState(0);
	const query = useQuery({
		queryKey: ["activity", "history", offset],
		queryFn: () => listActivity(offset, 20),
		retry: false,
		refetchInterval: 20000,
	});
	return (
		<section aria-label="Office activity history" className="grid gap-4">
			<div className="flex flex-wrap justify-between items-center gap-3">
				<p className="text-sm text-base-content/70">
					Business changes and feedback on your requests. These records do not
					start agents.
				</p>
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					disabled={query.isFetching}
					onClick={() => void query.refetch()}
				>
					Refresh activity
				</button>
			</div>
			{query.isPending && <p role="status">Loading office activity…</p>}
			{query.isError && (
				<p role="alert" className="alert alert-error">
					Could not load activity: {query.error.message}
				</p>
			)}
			{query.data && (
				<>
					<ol className="divide-y divide-base-300 rounded-box border border-base-300 bg-base-100">
						{query.data.entries.map((entry) => {
							const member = workspace.members.find(
								(m) => m.id === entry.actorId,
							);
							return (
								<li key={entry.id} className="p-4 flex gap-3 min-w-0">
									<MemberAvatar
										name={entry.actorName}
										avatarUrl={member?.avatarUrl}
										avatarFileId={member?.avatarFileId}
										className="size-9 shrink-0"
									/>
									<div className="min-w-0 grid gap-1">
										<p className="font-medium break-words">{entry.summary}</p>
										<p className="text-xs text-base-content/65">
											{entry.actorName}
											{entry.actorKind === "agent" ? " (AI)" : ""} ·{" "}
											{new Date(
												Number(entry.occurredAt) * 1000,
											).toLocaleString()}{" "}
											· {entry.kind.replaceAll("_", " ")}
										</p>
										{entry.sourceId && (
											<SourceLink
												kind={entry.sourceKind}
												id={entry.sourceId}
												revision={entry.sourceRevision}
											>
												Open related work
											</SourceLink>
										)}
									</div>
								</li>
							);
						})}
						{query.data.entries.length === 0 && (
							<li className="p-6 text-base-content/70">
								No activity recorded yet.
							</li>
						)}
					</ol>
					<nav
						aria-label="Activity pages"
						className="flex flex-wrap justify-between gap-3 items-center"
					>
						<p className="text-sm">
							{query.data.totalCount
								? `${offset + 1}–${offset + query.data.entries.length} of ${query.data.totalCount}`
								: "0 changes"}
						</p>
						<div className="flex gap-2">
							<button
								type="button"
								className="btn btn-sm"
								disabled={!offset || query.isFetching}
								onClick={() => setOffset(Math.max(0, offset - 20))}
							>
								Previous activity
							</button>
							<button
								type="button"
								className="btn btn-sm"
								disabled={!query.data.nextOffset || query.isFetching}
								onClick={() => setOffset(query.data.nextOffset)}
							>
								Next activity
							</button>
						</div>
					</nav>
				</>
			)}
		</section>
	);
}
