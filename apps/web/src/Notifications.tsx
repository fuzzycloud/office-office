import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import ActionIcon from "./ActionIcon";
import ActivityHistory from "./ActivityHistory";
import {
	createNotification,
	listNotifications,
	type Member,
	type Notification,
	type Project,
	type Task,
	updateNotification,
	type Workspace,
} from "./api";
import SourceLink from "./SourceLink";

const kinds = [
	["notice", "Notice"],
	["response_request", "Response request"],
	["work_request", "Work request"],
	["review_request", "Review request"],
	["blocker", "Blocker"],
] as const;
const statuses = [
	"pending",
	"claimed",
	"acknowledged",
	"dismissed",
	"cancelled",
];
const label = (value: string) => value.replaceAll("_", " ");
const time = (value: bigint) =>
	new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(Number(value) * 1000));

type ComposerProps = {
	members: Member[];
	projects?: Project[];
	tasks?: Task[];
	task?: Task;
	onClose: () => void;
	onBusyChange?: (busy: boolean) => void;
};
export function NotificationComposer({
	members,
	projects = [],
	tasks = [],
	task,
	onClose,
	onBusyChange,
}: ComposerProps) {
	const cache = useQueryClient();
	const [title, setTitle] = useState(
		task ? `Response requested: ${task.title}` : "",
	);
	const [body, setBody] = useState("");
	const [kind, setKind] = useState(task ? "response_request" : "notice");
	const [search, setSearch] = useState("");
	const [recipients, setRecipients] = useState<string[]>([]);
	const [source, setSource] = useState("");
	const attempt = useRef<{ payload: string; requestId: string } | null>(null);
	const sources = [
		...projects.map((p) => ({
			key: `project:${p.id}`,
			kind: "project",
			id: p.id,
			name: `Project: ${p.name}`,
		})),
		...tasks.map((t) => ({
			key: `task:${t.id}`,
			kind: "task",
			id: t.id,
			name: `Task: ${t.title}`,
		})),
	];
	const mutation = useMutation({
		mutationFn: async () => {
			const selected = sources.find((s) => s.key === source);
			const draft = {
				title: title.trim(),
				body: body.trim(),
				kind,
				recipientIds: recipients,
				sourceKind: task ? "task" : (selected?.kind ?? ""),
				sourceId: task?.id ?? selected?.id ?? "",
			};
			const payload = JSON.stringify(draft);
			if (attempt.current?.payload !== payload)
				attempt.current = { payload, requestId: crypto.randomUUID() };
			onBusyChange?.(true);
			try {
				return await createNotification({
					...draft,
					requestId: attempt.current.requestId,
				});
			} finally {
				onBusyChange?.(false);
			}
		},
		onSuccess: async () => {
			await cache.invalidateQueries({ queryKey: ["notifications"] });
			onClose();
		},
	});
	const eligible = members.filter((m) => m.status === "active");
	const matches = eligible.filter((m) =>
		`${m.name} ${m.jobTitle}`
			.toLocaleLowerCase()
			.includes(search.toLocaleLowerCase()),
	);
	return (
		<form
			className="rounded-box border border-base-300 bg-base-100 p-4 sm:p-6 mb-5"
			aria-label="Notification composer"
			onSubmit={(event) => {
				event.preventDefault();
				mutation.mutate();
			}}
		>
			<fieldset disabled={mutation.isPending} className="grid gap-4">
				<div className="flex justify-between items-center gap-3">
					<h2 className="text-xl font-semibold">
						{task ? "Request a response" : "Send notification"}
					</h2>
					<button
						type="button"
						className="btn btn-ghost btn-sm btn-square"
						aria-label="Close notification composer"
						onClick={onClose}
					>
						<ActionIcon name="close" />
					</button>
				</div>
				<p className="text-sm text-base-content/70">
					Notices share information. Requests ask a teammate to respond or act.
					Sending a request does not start an agent.
				</p>
				<label className="form-control grid gap-1">
					<span>Type</span>
					<select
						className="select select-bordered w-full"
						value={kind}
						onChange={(e) => setKind(e.target.value)}
					>
						{kinds.map(([value, name]) => (
							<option key={value} value={value}>
								{name}
							</option>
						))}
					</select>
				</label>
				<fieldset className="border border-base-300 rounded-box p-3">
					<legend className="px-1 font-medium">
						Recipients ({recipients.length}/20)
					</legend>
					<label className="grid gap-1">
						<span className="text-sm">Search recipients</span>
						<input
							type="search"
							className="input input-bordered w-full"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</label>
					<div className="grid gap-1 max-h-48 overflow-y-auto mt-2 sm:grid-cols-2">
						{matches.map((m) => (
							<label
								key={m.id}
								className="flex gap-2 items-center p-2 cursor-pointer"
							>
								<input
									type="checkbox"
									className="checkbox checkbox-sm"
									checked={recipients.includes(m.id)}
									disabled={
										!recipients.includes(m.id) && recipients.length >= 20
									}
									onChange={(e) =>
										setRecipients((ids) =>
											e.target.checked
												? [...ids, m.id]
												: ids.filter((id) => id !== m.id),
										)
									}
								/>
								<span>
									{m.name}{" "}
									{m.kind === "agent" && (
										<span className="badge badge-outline badge-sm">AI</span>
									)}
								</span>
							</label>
						))}
					</div>
					{!matches.length && (
						<p className="text-sm py-2">
							No active teammates match your search.
						</p>
					)}
					{!!recipients.length && (
						<p className="text-sm text-base-content/70 mt-2">
							Selected:{" "}
							{eligible
								.filter((m) => recipients.includes(m.id))
								.map((m) => m.name)
								.join(", ")}
						</p>
					)}
				</fieldset>
				<label className="grid gap-1">
					<span>Title</span>
					<input
						className="input input-bordered w-full"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						required
						maxLength={200}
					/>
				</label>
				<label className="grid gap-1">
					<span>Message</span>
					<textarea
						className="textarea textarea-bordered min-h-28 w-full"
						value={body}
						onChange={(e) => setBody(e.target.value)}
						required
						maxLength={10000}
					/>
				</label>
				{task ? (
					<p className="text-sm">Linked task: {task.title}</p>
				) : (
					<label className="grid gap-1">
						<span>Related work (optional)</span>
						<select
							className="select select-bordered w-full"
							value={source}
							onChange={(e) => setSource(e.target.value)}
						>
							<option value="">No linked work</option>
							{sources.map((s) => (
								<option key={s.key} value={s.key}>
									{s.name}
								</option>
							))}
						</select>
					</label>
				)}
				{mutation.isError && (
					<p role="alert" className="text-error">
						{mutation.error.message} Your draft is preserved.
					</p>
				)}
				<div className="flex justify-end gap-2">
					<button type="button" className="btn btn-ghost" onClick={onClose}>
						Cancel
					</button>
					<button
						type="submit"
						className="btn btn-primary"
						disabled={!recipients.length || !title.trim() || !body.trim()}
					>
						{mutation.isPending ? "Sending…" : "Send notification"}
					</button>
				</div>
			</fieldset>
		</form>
	);
}

function MemberName({ id, members }: { id: string; members: Member[] }) {
	const member = members.find((m) => m.id === id);
	return (
		<span>
			{member?.name || "Unavailable teammate"}{" "}
			{member?.kind === "agent" && (
				<span className="badge badge-outline badge-sm">AI</span>
			)}
		</span>
	);
}
function NotificationItem({
	notification: n,
	workspace,
}: {
	notification: Notification;
	workspace: Workspace;
}) {
	const cache = useQueryClient();
	const [confirmCancel, setConfirmCancel] = useState(false);
	const [note, setNote] = useState("");
	const mine = n.recipientId === workspace.currentUser.id;
	const terminal = ["acknowledged", "dismissed", "cancelled"].includes(
		n.status,
	);
	const reviewRequest = n.sourceKind === "report_review";
	const canCancel =
		!reviewRequest &&
		!terminal &&
		(n.senderId === workspace.currentUser.id ||
			workspace.currentUser.role === "admin");
	const mutation = useMutation({
		mutationFn: (action: string) =>
			updateNotification({
				id: n.id,
				expectedRevision: n.revision,
				action,
				claimId: action === "read" ? "" : n.claimId,
				note: action === "read" ? "" : note.trim(),
			}),
		onSuccess: async (_response, action) => {
			setConfirmCancel(false);
			if (action !== "read") setNote("");
			await cache.invalidateQueries({ queryKey: ["notifications"] });
		},
	});
	const sourceRoute = Boolean(n.sourceKind && n.sourceId);
	return (
		<article
			id={`source-notification-${n.id}`}
			className="p-4 sm:p-6"
			aria-label={n.title}
		>
			<div className="flex flex-wrap gap-2 items-center text-sm mb-2">
				<span className="badge badge-outline">{label(n.kind)}</span>
				<span
					className={`badge ${n.status === "pending" ? "badge-warning" : "badge-ghost"}`}
				>
					{label(n.status)}
				</span>
				<span className="text-base-content/65">
					{n.readAt > 0n ? `Read ${time(n.readAt)}` : "Unread"}
				</span>
			</div>
			<h2 className="text-lg font-semibold break-words">{n.title}</h2>
			<p className="whitespace-pre-wrap break-words max-w-prose mt-2">
				{n.body}
			</p>
			<div className="text-sm text-base-content/70 grid gap-1 mt-3">
				<p>
					From <MemberName id={n.senderId} members={workspace.members} /> to{" "}
					<MemberName id={n.recipientId} members={workspace.members} />
				</p>
				<p>Sent {time(n.createdAt)}</p>
				{n.revision > 1 && (
					<p>
						Updated {time(n.updatedAt)} by{" "}
						<MemberName id={n.updatedBy} members={workspace.members} />
					</p>
				)}
				{sourceRoute && (
					<p>
						<SourceLink
							kind={n.sourceKind}
							id={n.sourceId}
							revision={n.sourceRevision}
							className="link"
						>
							Open related {label(n.sourceKind)}
						</SourceLink>{" "}
						<span>
							{" "}
							—{" "}
							{workspace.tasks.find(
								(t) => n.sourceKind === "task" && t.id === n.sourceId,
							)?.title ||
								workspace.projects.find(
									(p) => n.sourceKind === "project" && p.id === n.sourceId,
								)?.name ||
								`Related ${n.sourceKind}`}
						</span>
					</p>
				)}
				{n.resultId && (
					<p>
						<SourceLink
							kind={n.resultKind}
							id={n.resultId}
							revision={n.resultRevision}
							className="link"
						>
							Open result {n.resultKind}
							{n.resultRevision ? ` revision ${n.resultRevision}` : ""}
						</SourceLink>
					</p>
				)}
				{n.note && (
					<p className="whitespace-pre-wrap break-words">Note: {n.note}</p>
				)}
				{n.status === "claimed" && (
					<p>A teammate or connected service has claimed this request.</p>
				)}
			</div>
			{reviewRequest && !terminal && (
				<p className="mt-3 text-sm">
					<SourceLink
						kind={n.sourceKind}
						id={n.sourceId}
						revision={n.sourceRevision}
					>
						Review this report or cancel its review request
					</SourceLink>
					. Review decisions are recorded on the report.
				</p>
			)}
			{(mine || canCancel) && (
				<fieldset disabled={mutation.isPending} className="mt-4 grid gap-3">
					{!terminal && !reviewRequest && (
						<label className="grid gap-1 max-w-prose">
							<span className="text-sm">Response note (optional)</span>
							<input
								className="input input-bordered input-sm w-full"
								value={note}
								onChange={(e) => setNote(e.target.value)}
								maxLength={2000}
							/>
						</label>
					)}
					<div className="flex flex-wrap gap-2">
						{mine && n.readAt === 0n && (
							<button
								type="button"
								className="btn btn-sm btn-ghost"
								onClick={() => mutation.mutate("read")}
							>
								Mark read
							</button>
						)}
						{mine && !terminal && !reviewRequest && (
							<>
								<button
									type="button"
									className="btn btn-sm btn-primary"
									onClick={() => mutation.mutate("acknowledge")}
								>
									Acknowledge
								</button>
								<button
									type="button"
									className="btn btn-sm btn-ghost"
									onClick={() => mutation.mutate("dismiss")}
								>
									Dismiss
								</button>
							</>
						)}
						{canCancel &&
							(confirmCancel ? (
								<>
									<span className="self-center text-sm">
										Cancel this notification?
									</span>
									<button
										type="button"
										className="btn btn-error btn-sm"
										onClick={() => mutation.mutate("cancel")}
									>
										Confirm cancellation
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-sm"
										onClick={() => setConfirmCancel(false)}
									>
										Keep notification
									</button>
								</>
							) : (
								<button
									type="button"
									className="btn btn-ghost btn-sm"
									onClick={() => setConfirmCancel(true)}
								>
									Cancel request
								</button>
							))}
					</div>
				</fieldset>
			)}
			{mutation.isError && (
				<p role="alert" className="text-error text-sm mt-2">
					{mutation.error.message} Refresh notifications to check the latest
					status before retrying.
				</p>
			)}
		</article>
	);
}

export default function Notifications({ workspace }: { workspace: Workspace }) {
	const [scope, setScope] = useState("inbox");
	const [status, setStatus] = useState("");
	const [offset, setOffset] = useState(0);
	const [compose, setCompose] = useState(false);
	const query = useQuery({
		queryKey: ["notifications", scope, status, offset],
		queryFn: () => listNotifications({ scope, status, pageSize: 20, offset }),
		enabled: scope !== "activity",
		retry: false,
		refetchInterval: 20000,
		refetchIntervalInBackground: false,
	});
	const scopes = [
		["activity", "Office activity"],
		["inbox", "My inbox"],
		["sent", "Sent"],
		...(workspace.currentUser.role === "admin" ? [["all", "All"]] : []),
	];
	return (
		<section aria-label="Notifications" className="max-w-5xl">
			<div className="flex flex-wrap items-start justify-between gap-4 mb-5">
				<div>
					<h2 className="text-2xl font-semibold">Notification board</h2>
					<p className="text-base-content/70 mt-1">
						Requests and updates for your office. Reading and acknowledging are
						separate actions.
					</p>
				</div>
				{workspace.currentUser.role !== "viewer" && !compose && (
					<button
						type="button"
						className="btn btn-primary"
						onClick={() => setCompose(true)}
					>
						<ActionIcon name="plus" />
						Send notification
					</button>
				)}
			</div>
			{compose && (
				<NotificationComposer
					members={workspace.members}
					projects={workspace.projects}
					tasks={workspace.tasks}
					onClose={() => setCompose(false)}
				/>
			)}
			<div className="flex flex-wrap items-center gap-3 mb-4">
				<fieldset className="join" aria-label="Notification scope">
					{scopes.map(([value, name]) => (
						<button
							type="button"
							key={value}
							className={`btn btn-sm join-item ${scope === value ? "btn-primary" : "btn-ghost"}`}
							aria-pressed={scope === value}
							onClick={() => {
								setScope(value);
								setOffset(0);
							}}
						>
							{name}
						</button>
					))}
				</fieldset>
				{scope !== "activity" && (
					<label className="flex items-center gap-2 text-sm">
						<span>Status</span>
						<select
							className="select select-bordered select-sm"
							value={status}
							onChange={(e) => {
								setStatus(e.target.value);
								setOffset(0);
							}}
						>
							<option value="">All statuses</option>
							{statuses.map((s) => (
								<option key={s} value={s}>
									{label(s)}
								</option>
							))}
						</select>
					</label>
				)}
				{scope !== "activity" && (
					<button
						type="button"
						className="btn btn-ghost btn-sm sm:ml-auto"
						aria-label="Refresh notifications"
						disabled={query.isFetching}
						onClick={() => void query.refetch()}
					>
						<ActionIcon name="refresh" />
						Refresh
					</button>
				)}
			</div>
			{scope === "activity" ? (
				<ActivityHistory workspace={workspace} />
			) : (
				<>
					{query.isPending && <p role="status">Loading notifications…</p>}
					{query.isError && (
						<p role="alert" className="alert alert-error">
							Could not load notifications: {query.error.message}
						</p>
					)}
					{query.data && (
						<>
							<div className="bg-base-100 border border-base-300 rounded-box divide-y divide-base-300">
								{query.data.notifications.length ? (
									query.data.notifications.map((n) => (
										<NotificationItem
											key={n.id}
											notification={n}
											workspace={workspace}
										/>
									))
								) : (
									<p className="p-6 text-base-content/70">
										No notifications match this view.
									</p>
								)}
							</div>
							<div className="flex flex-wrap justify-between items-center gap-3 mt-4 text-sm">
								<p>
									{query.data.totalCount
										? `${offset + 1}–${offset + query.data.notifications.length} of ${query.data.totalCount}`
										: "0 notifications"}
								</p>
								<div className="flex gap-2">
									<button
										type="button"
										className="btn btn-sm"
										disabled={!offset || query.isFetching}
										onClick={() => setOffset(Math.max(0, offset - 20))}
									>
										Previous
									</button>
									<button
										type="button"
										className="btn btn-sm"
										disabled={!query.data.nextOffset || query.isFetching}
										onClick={() => setOffset(query.data.nextOffset)}
									>
										Next
									</button>
								</div>
							</div>
						</>
					)}
				</>
			)}
		</section>
	);
}
