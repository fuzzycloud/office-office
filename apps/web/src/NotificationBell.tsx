import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import MemberAvatar from "./MemberAvatar";
import ActionIcon from "./ActionIcon";
import {
	listActivity,
	listNotifications,
	updateNotification,
	type Notification,
	type Workspace,
} from "./api";
import SourceLink from "./SourceLink";

export default function NotificationBell({
	workspace,
}: {
	workspace: Workspace;
}) {
	const [open, setOpen] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);
	const opener = useRef<HTMLButtonElement>(null);
	const wasOpen = useRef(false);
	const cache = useQueryClient();
	const inbox = useQuery({
		queryKey: ["notifications", "bell", workspace.currentUser.id],
		queryFn: async () => {
			const all: Notification[] = [];
			let offset = 0;
			do {
				const page = await listNotifications({
					scope: "inbox",
					status: "",
					pageSize: 100,
					offset,
				});
				all.push(...page.notifications);
				offset = page.nextOffset;
			} while (offset);
			return all;
		},
		refetchInterval: 20000,
		retry: false,
	});
	const activity = useQuery({
		queryKey: ["activity", "bell"],
		queryFn: () => listActivity(0, 8),
		enabled: open,
		refetchInterval: 20000,
		retry: false,
	});
	const markRead = useMutation({
		mutationFn: (n: Notification) =>
			updateNotification({
				id: n.id,
				expectedRevision: n.revision,
				action: "read",
				claimId: "",
				note: "",
			}),
		onSuccess: async () => {
			await cache.invalidateQueries({ queryKey: ["notifications"] });
		},
	});
	useEffect(() => {
		if (open) dialog.current?.showModal();
		else if (wasOpen.current) {
			dialog.current?.close();
			opener.current?.focus();
		}
		wasOpen.current = open;
	}, [open]);
	const unread = inbox.data?.filter((n) => n.readAt === 0n).length || 0;
	const attention =
		inbox.data?.filter(
			(n) => ["pending", "claimed"].includes(n.status) && n.kind !== "notice",
		) || [];
	const updates =
		inbox.data?.filter((n) => n.kind === "notice" && n.readAt === 0n) || [];
	return (
		<>
			<button
				ref={opener}
				type="button"
				className="btn btn-ghost btn-circle relative"
				aria-label={`Notifications, ${unread} unread`}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<ActionIcon name="bell" size={22} />
				{unread > 0 && (
					<span
						className="badge badge-primary badge-xs absolute right-0 top-0"
						aria-hidden="true"
					>
						{unread > 99 ? "99+" : unread}
					</span>
				)}
			</button>
			{open && (
				<dialog
					ref={dialog}
					className="modal modal-bottom sm:modal-middle"
					aria-label="Office notifications"
					onCancel={(event) => {
						event.preventDefault();
						setOpen(false);
					}}
				>
					<div className="modal-box w-full max-w-2xl max-h-[85dvh] p-0">
						<header className="flex items-center justify-between p-4 border-b border-base-300">
							<div>
								<h2 className="font-semibold text-xl">Notifications</h2>
								<p className="text-sm text-base-content/65">
									{unread} unread · {attention.length} need attention
								</p>
							</div>
							<button
								className="btn btn-ghost btn-square btn-sm"
								aria-label="Close notifications"
								onClick={() => setOpen(false)}
							>
								<ActionIcon name="close" />
							</button>
						</header>
						<div className="p-4 grid gap-5">
							<section>
								<h3 className="font-semibold mb-2">Needs attention</h3>
								<p className="text-xs text-base-content/65 mb-3">
									Reading a request keeps it here until it is handled.
								</p>
								{inbox.isPending ? (
									<p role="status">Loading requests…</p>
								) : inbox.isError ? (
									<p role="alert">
										Could not load notifications.{" "}
										<button
											className="link"
											onClick={() => void inbox.refetch()}
										>
											Retry
										</button>
									</p>
								) : !attention.length ? (
									<p className="text-sm text-base-content/65">
										No requests need your attention.
									</p>
								) : (
									<ul className="divide-y divide-base-300">
										{attention.map((n) => (
											<li key={n.id} className="py-3 grid gap-1">
												<div className="flex gap-2 items-center flex-wrap">
													<MemberAvatar
														name={
															workspace.members.find((m) => m.id === n.senderId)
																?.name || "Teammate"
														}
														avatarFileId={
															workspace.members.find((m) => m.id === n.senderId)
																?.avatarFileId
														}
														avatarUrl={
															workspace.members.find((m) => m.id === n.senderId)
																?.avatarUrl
														}
														className="size-8"
													/>
													<strong>{n.title}</strong>
													<span
														className={`badge badge-sm ${n.status === "claimed" ? "badge-info" : "badge-warning"}`}
													>
														{n.status}
													</span>
												</div>
												<p className="text-sm text-base-content/65">
													From{" "}
													{workspace.members.find((m) => m.id === n.senderId)
														?.name || "Teammate"}{" "}
													· {n.readAt === 0n ? "Unread" : "Read"}
												</p>
												<p className="text-sm whitespace-pre-wrap break-words">
													{n.body}
												</p>
												<div className="flex flex-wrap gap-3 mt-1">
													{n.sourceId && (
														<SourceLink
															kind={n.sourceKind}
															id={n.sourceId}
															revision={n.sourceRevision}
															onClick={() => setOpen(false)}
														>
															Open related {n.sourceKind}
														</SourceLink>
													)}
													{n.readAt === 0n && (
														<button
															className="btn btn-ghost btn-xs"
															disabled={markRead.isPending}
															onClick={() => markRead.mutate(n)}
														>
															Mark read
														</button>
													)}
													<a
														className="link text-sm"
														href="/notifications"
														onClick={() => setOpen(false)}
													>
														Respond
													</a>
												</div>
											</li>
										))}
									</ul>
								)}
							</section>
							{updates.length > 0 && (
								<section>
									<h3 className="font-semibold">Unread updates</h3>
									<ul className="divide-y divide-base-300">
										{updates.map((n) => (
											<li
												key={n.id}
												className="py-2 flex items-center justify-between gap-2"
											>
												<span className="text-sm">{n.title}</span>
												<button
													className="btn btn-ghost btn-xs"
													disabled={markRead.isPending}
													onClick={() => markRead.mutate(n)}
												>
													Mark read
												</button>
											</li>
										))}
									</ul>
								</section>
							)}
							{markRead.isError && (
								<p role="alert" className="text-error text-sm">
									{markRead.error.message}
								</p>
							)}
							<section>
								<h3 className="font-semibold mb-2">Recent activity</h3>
								{activity.isPending ? (
									<p role="status">Loading activity…</p>
								) : activity.isError ? (
									<p role="alert" className="text-sm">
										Could not load activity.{" "}
										<button
											className="link"
											onClick={() => void activity.refetch()}
										>
											Retry
										</button>
									</p>
								) : (
									<ul className="divide-y divide-base-300">
										{activity.data?.entries.map((entry) => (
											<li key={entry.id} className="py-2">
												<div className="flex items-start gap-2">
													<MemberAvatar
														name={entry.actorName || "Office"}
														avatarFileId={
															workspace.members.find(
																(m) => m.id === entry.actorId,
															)?.avatarFileId
														}
														avatarUrl={
															workspace.members.find(
																(m) => m.id === entry.actorId,
															)?.avatarUrl
														}
														className="size-7"
													/>
													<p className="text-sm">{entry.summary}</p>
												</div>
												<p className="text-xs text-base-content/65">
													{entry.actorName || "Office"}
													{entry.actorKind === "agent" ? " (AI)" : ""} ·{" "}
													{new Date(
														Number(entry.occurredAt) * 1000,
													).toLocaleString()}
												</p>
												{entry.sourceId && (
													<SourceLink
														className="link text-xs"
														kind={entry.sourceKind}
														id={entry.sourceId}
														revision={entry.sourceRevision}
														onClick={() => setOpen(false)}
													>
														Open {entry.sourceKind}
													</SourceLink>
												)}
											</li>
										))}
									</ul>
								)}
								{activity.data?.entries.length === 0 && (
									<p className="text-sm text-base-content/65">
										No activity recorded yet.
									</p>
								)}
							</section>
						</div>
						<footer className="p-4 border-t border-base-300">
							<a
								href="/notifications"
								className="btn btn-primary btn-sm w-full"
								onClick={() => setOpen(false)}
							>
								View full notification history
							</a>
						</footer>
					</div>
					<form
						method="dialog"
						className="modal-backdrop"
						onSubmit={(event) => {
							event.preventDefault();
							setOpen(false);
						}}
					>
						<button>Close notifications</button>
					</form>
				</dialog>
			)}
		</>
	);
}
