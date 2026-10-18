import { Code, ConnectError } from "@connectrpc/connect";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import ActionIcon from "./ActionIcon";
import {
	deleteTaskComment,
	getReport,
	listNotifications,
	listReports,
	listTaskDiscussion,
	type Member,
	saveTaskComment,
	type Task,
} from "./api";
import ConversationBody from "./ConversationBody";
import ConversationComposer from "./ConversationComposer";
import { emptySelection, ReferenceLinks } from "./ConversationFields";
import ConversationReceipt, {
	type SavedConversation,
} from "./ConversationReceipt";
import MemberAvatar from "./MemberAvatar";
import { NotificationComposer } from "./Notifications";
import { useSourceAnchor } from "./SourceLink";

const time = (value: bigint) =>
	new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(Number(value) * 1000));
export default function TaskDetails({
	task,
	members,
	columns,
	currentUser,
	canEdit,
	canReadReports,
	projectName,
	boardName,
	onClose,
	onSave,
}: {
	task: Task;
	members: Member[];
	columns: string[];
	currentUser: Member;
	canEdit: boolean;
	canReadReports: boolean;
	projectName: string;
	boardName: string;
	onClose: () => void;
	onSave: (task: Task) => Promise<unknown>;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const id = useId();
	const cache = useQueryClient();
	const [tab, setTab] = useState("comments");
	const [editingTask, setEditingTask] = useState(false);
	const [draft, setDraft] = useState(task);
	const [body, setBody] = useState("");
	const [savedConversation, setSavedConversation] =
		useState<SavedConversation | null>(null);
	const [selection, setSelection] = useState(emptySelection);
	const [parentId, setParentId] = useState("");
	const [editComment, setEditComment] = useState<{
		id: string;
		revision: number;
	} | null>(null);
	const [deleteId, setDeleteId] = useState("");
	const [error, setError] = useState("");
	const [conflict, setConflict] = useState(false);
	const [reportId, setReportId] = useState("");
	const [requestResponse, setRequestResponse] = useState(false);
	const [notificationBusy, setNotificationBusy] = useState(false);
	useEffect(() => {
		const opener =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		dialog.current?.showModal();
		return () => {
			dialog.current?.close();
			opener?.focus();
		};
	}, []);
	const attention = useQuery({
		queryKey: ["notifications", "task", task.id],
		queryFn: () =>
			listNotifications({
				scope: "inbox",
				status: "",
				pageSize: 100,
				offset: 0,
			}),
		retry: false,
		refetchInterval: 20000,
	});
	const linkedAttention =
		attention.data?.notifications.filter(
			(n) => n.sourceKind === "task" && n.sourceId === task.id,
		) || [];
	const discussion = useQuery({
		queryKey: ["task-discussion", task.id],
		queryFn: () => listTaskDiscussion(task.id),
		retry: false,
	});
	const reports = useQuery({
		queryKey: ["task-reports", task.id],
		enabled: canReadReports,
		queryFn: async () => {
			const matches = [];
			let offset = 0;
			do {
				const page = await listReports({
					query: "",
					status: "",
					projectId: task.projectId,
					pageSize: 100,
					offset,
				});
				matches.push(
					...page.reports.filter((report) => report.taskId === task.id),
				);
				offset = page.nextOffset;
			} while (offset);
			return matches;
		},
		retry: false,
	});
	const report = useQuery({
		queryKey: ["report", reportId],
		queryFn: () => getReport(reportId),
		enabled: canReadReports && !!reportId,
		retry: false,
	});
	const refresh = async () => {
		await Promise.all([
			cache.invalidateQueries({ queryKey: ["task-discussion", task.id] }),
			cache.invalidateQueries({ queryKey: ["workspace"] }),
			cache.invalidateQueries({ queryKey: ["notifications"] }),
		]);
	};
	const mutation = useMutation({
		// Freeze receipt intent before any background refresh can observe this write.
		onMutate: () => ({
			kind: "task_comment" as const,
			contextId: task.id,
			expected: {
				mentionIds: [...selection.mentionIds],
				responseRecipientIds: [...selection.responseRecipientIds],
				parentId,
			},
			previous: (() => {
				const old = discussion.data?.comments.find(
					(record) => record.id === editComment?.id,
				);
				return old
					? {
							mentionIds: [...old.mentionIds],
							responseRecipientIds: [...old.responseRecipientIds],
						}
					: undefined;
			})(),
			replyRecipientId: (() => {
				const authorId = discussion.data?.comments.find(
					(record) => record.id === parentId,
				)?.authorId;
				return authorId &&
					authorId !== currentUser.id &&
					members.some(
						(member) => member.id === authorId && member.status === "active",
					)
					? authorId
					: "";
			})(),
			previousRevision: editComment?.revision,
		}),
		mutationFn: async (action: "save" | "delete") => {
			if (action === "delete") {
				const comment = discussion.data?.comments.find(
					(c) => c.id === deleteId,
				);
				if (!comment) throw new Error("Reload comments and try again.");
				return deleteTaskComment({
					taskId: task.id,
					commentId: comment.id,
					expectedRevision: comment.revision,
				});
			}
			return saveTaskComment({
				taskId: task.id,
				commentId: editComment?.id || "",
				body: body.trim(),
				parentId,
				...selection,
				expectedRevision: editComment?.revision || 0,
			});
		},
		onSuccess: async (result, action, submitted) => {
			if (action === "save" && result.comment && submitted)
				setSavedConversation({
					...submitted,
					id: result.comment.id,
					revision: result.comment.revision,
					unchanged: submitted.previousRevision === result.comment.revision,
				});
			if (action === "save" || editComment?.id === deleteId) {
				setBody("");
				setParentId("");
				setSelection(emptySelection());
				setEditComment(null);
			}
			setDeleteId("");
			setError("");
			setConflict(false);
			await refresh();
		},
		onError: (err) => {
			const stale =
				err instanceof ConnectError &&
				(err.code === Code.Aborted || err.code === Code.FailedPrecondition);
			setConflict(stale);
			setError(
				stale
					? "This comment changed while you were editing. Your draft is kept below. Reload the discussion, then review the latest comment before editing again."
					: err.message,
			);
		},
	});
	const saveTaskMutation = useMutation({
		mutationFn: () => onSave(draft),
		onSuccess: async () => {
			setEditingTask(false);
			await refresh();
		},
	});
	const busy =
		mutation.isPending || saveTaskMutation.isPending || notificationBusy;
	const comments = discussion.data?.comments || [];
	const replyParent = comments.find((comment) => comment.id === parentId);
	const change = (key: keyof Task, value: string) =>
		setDraft((current) => ({ ...current, [key]: value }));
	useSourceAnchor(discussion.data);
	return (
		<dialog
			ref={dialog}
			className="modal task-dialog"
			aria-labelledby={`${id}-title`}
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<div className="modal-box task-detail-box">
				<header className="task-detail-header">
					<div>
						<p className="text-sm text-base-content/65">
							{projectName} / {boardName}
						</p>
						<h2 id={`${id}-title`}>{task.title}</h2>
					</div>
					<button
						className="btn btn-ghost btn-circle btn-sm"
						aria-label="Close task details"
						title="Close task details"
						onClick={onClose}
						disabled={busy}
					>
						<ActionIcon name="close" />
					</button>
				</header>
				<div className="task-detail-layout">
					<section
						className="task-detail-content"
						aria-label="Task description and discussion"
					>
						{linkedAttention.length > 0 && (
							<div className="flex flex-wrap gap-2 mb-3">
								<span className="badge badge-primary badge-outline">
									{linkedAttention.filter((n) => n.readAt === 0n).length} unread
								</span>
								<span className="badge badge-warning badge-outline">
									{
										linkedAttention.filter(
											(n) =>
												n.kind !== "notice" &&
												["pending", "claimed"].includes(n.status),
										).length
									}{" "}
									need response
								</span>
								<a className="link text-sm" href="/notifications">
									Open requests
								</a>
							</div>
						)}
						{currentUser.role !== "viewer" && !requestResponse && (
							<button
								type="button"
								className="btn btn-outline btn-sm mb-4"
								onClick={() => setRequestResponse(true)}
							>
								Request response
							</button>
						)}
						{requestResponse && (
							<NotificationComposer
								members={members}
								task={task}
								onClose={() => setRequestResponse(false)}
								onBusyChange={setNotificationBusy}
							/>
						)}
						{editingTask ? (
							<form
								className="task-edit-form"
								onSubmit={(event) => {
									event.preventDefault();
									saveTaskMutation.mutate();
								}}
							>
								<fieldset disabled={busy} className="grid gap-4">
									<label className="form-control">
										<span className="label-text mb-1">Task title</span>
										<input
											className="input input-bordered w-full"
											value={draft.title}
											onChange={(event) => change("title", event.target.value)}
											required
											maxLength={200}
										/>
									</label>
									<div className="form-control">
										<label
											className="label-text mb-1"
											htmlFor={`${id}-description`}
										>
											Description
										</label>
										<textarea
											id={`${id}-description`}
											className="textarea textarea-bordered min-h-48 w-full"
											value={draft.description}
											onChange={(event) =>
												change("description", event.target.value)
											}
										/>
									</div>
									<div className="task-property-edit">
										<div className="form-control">
											<label
												className="label-text mb-1"
												htmlFor={`${id}-owner`}
											>
												Owner
											</label>
											<select
												id={`${id}-owner`}
												className="select select-bordered"
												value={draft.assigneeId}
												onChange={(event) =>
													change("assigneeId", event.target.value)
												}
											>
												<option value="">Unassigned</option>
												{members
													.filter(
														(m) =>
															m.status === "active" ||
															m.id === draft.assigneeId,
													)
													.map((m) => (
														<option key={m.id} value={m.id}>
															{m.name}
														</option>
													))}
											</select>
										</div>
										<div className="form-control">
											<label
												className="label-text mb-1"
												htmlFor={`${id}-priority`}
											>
												Priority
											</label>
											<select
												id={`${id}-priority`}
												className="select select-bordered"
												value={draft.priority}
												onChange={(event) =>
													change("priority", event.target.value)
												}
											>
												{["low", "medium", "high", "urgent"].map((p) => (
													<option key={p}>{p}</option>
												))}
											</select>
										</div>
										<div className="form-control">
											<label
												className="label-text mb-1"
												htmlFor={`${id}-column`}
											>
												Column
											</label>
											<select
												id={`${id}-column`}
												className="select select-bordered"
												value={draft.column}
												onChange={(event) =>
													change("column", event.target.value)
												}
											>
												{columns.map((c) => (
													<option key={c}>{c}</option>
												))}
											</select>
										</div>
										<label className="form-control">
											<span className="label-text mb-1">Due date</span>
											<input
												type="date"
												className="input input-bordered"
												value={draft.dueDate}
												onChange={(event) =>
													change("dueDate", event.target.value)
												}
											/>
										</label>
									</div>
									{saveTaskMutation.isError && (
										<p role="alert" className="text-error">
											{saveTaskMutation.error.message}
										</p>
									)}
									<div className="flex justify-end gap-2">
										<button
											type="button"
											className="btn btn-ghost btn-sm"
											onClick={() => setEditingTask(false)}
										>
											Cancel
										</button>
										<button className="btn btn-primary btn-sm">
											{saveTaskMutation.isPending ? "Saving…" : "Save task"}
										</button>
									</div>
								</fieldset>
							</form>
						) : (
							<section className="task-description-reading">
								<div className="flex items-center justify-between gap-3">
									<h3>Description</h3>
									{canEdit && (
										<button
											className="btn btn-ghost btn-sm"
											onClick={() => {
												setDraft(task);
												saveTaskMutation.reset();
												setEditingTask(true);
											}}
										>
											<ActionIcon name="edit" />
											Edit task
										</button>
									)}
								</div>
								<p>{task.description || "No description yet."}</p>
							</section>
						)}
						<div
							className="task-discussion-tabs"
							role="tablist"
							aria-label="Task discussion"
						>
							{["comments", "activity"].map((value) => (
								<button
									key={value}
									id={`${id}-${value}-tab`}
									role="tab"
									aria-selected={tab === value}
									aria-controls={`${id}-panel`}
									className={`btn btn-sm ${tab === value ? "btn-primary" : "btn-ghost"}`}
									onClick={() => setTab(value)}
								>
									{value === "comments"
										? `Comments${discussion.data ? ` (${comments.filter((c) => !c.deleted).length})` : ""}`
										: "Activity"}
								</button>
							))}
							<button
								className="btn btn-ghost btn-sm ml-auto"
								aria-label="Refresh discussion"
								disabled={discussion.isFetching || busy}
								onClick={() => void discussion.refetch()}
							>
								<ActionIcon name="refresh" />
								Refresh
							</button>
						</div>
						<section
							id={`${id}-panel`}
							role="tabpanel"
							aria-labelledby={`${id}-${tab}-tab`}
							className="task-discussion-panel"
						>
							{discussion.isPending && (
								<p role="status" className="py-5 text-base-content/65">
									Loading discussion…
								</p>
							)}
							{discussion.isError && (
								<div role="alert" className="alert alert-error">
									<span>
										Could not load discussion: {discussion.error.message}
									</span>
									<button
										className="btn btn-sm"
										onClick={() => void discussion.refetch()}
									>
										Retry
									</button>
								</div>
							)}
							{error && (
								<div role="alert" className="alert alert-error">
									<div>
										<p>{error}</p>
										{conflict && (
											<button
												className="btn btn-sm mt-2"
												onClick={async () => {
													const result = await discussion.refetch();
													if (result.isSuccess) {
														setEditComment(null);
														setDeleteId("");
														setConflict(false);
														setError(
															"Discussion reloaded. Your text is preserved as a new comment draft. Select Edit on the latest comment to replace it.",
														);
													}
												}}
											>
												Reload discussion
											</button>
										)}
									</div>
								</div>
							)}
							{discussion.data && tab === "comments" && (
								<>
									{!comments.length && (
										<p className="task-discussion-empty">
											No comments yet. Add context, a question, or a progress
											update.
										</p>
									)}
									<div className="task-comment-list">
										{comments.map((comment) => (
											<article
												className={`task-comment ${comment.parentId ? "ml-4 border-l-2 border-base-300 pl-3" : ""}`}
												key={comment.id}
												id={`source-task_comment-${comment.id}`}
											>
												{comment.parentId && (
													<p className="text-xs text-base-content/65">
														<a
															className="link"
															href={`#source-task_comment-${comment.parentId}`}
														>
															Reply to{" "}
														</a>{" "}
														{comments.find((c) => c.id === comment.parentId)
															?.authorName || "earlier comment"}
													</p>
												)}
												<div className="task-comment-byline">
													{(() => {
														const author = members.find(
															(member) => member.id === comment.authorId,
														);
														return author ? (
															<MemberAvatar
																name={author.name}
																avatarUrl={author.avatarUrl}
																avatarFileId={author.avatarFileId}
																className="size-8"
															/>
														) : null;
													})()}
													<strong>
														{comment.authorName || "Unknown author"}
													</strong>
													{comment.actorKind === "agent" && (
														<span className="badge badge-outline badge-sm">
															Agent
														</span>
													)}
													<time
														dateTime={new Date(
															Number(comment.createdAt) * 1000,
														).toISOString()}
													>
														{time(comment.createdAt)}
													</time>
													{comment.revision > 1 && !comment.deleted && (
														<span title={`Edited ${time(comment.updatedAt)}`}>
															Edited
														</span>
													)}
												</div>
												<p
													className={
														comment.deleted ? "text-base-content/55 italic" : ""
													}
												>
													{comment.deleted ? (
														"Comment deleted"
													) : (
														<ConversationBody
															body={comment.body}
															members={members}
															mentionIds={comment.mentionIds}
															responseRecipientIds={
																comment.responseRecipientIds
															}
														/>
													)}
												</p>
												{!comment.deleted && (
													<>
														<p className="text-sm text-base-content/65">
															{comment.mentionIds
																.map(
																	(id) =>
																		`@${members.find((m) => m.id === id)?.name || "Unavailable teammate"}`,
																)
																.join(" ")}
														</p>
														<ReferenceLinks references={comment.references} />
														{comment.responseRecipientIds.length > 0 && (
															<p className="text-xs text-warning">
																Response requested from{" "}
																{comment.responseRecipientIds
																	.map(
																		(id) =>
																			members.find((m) => m.id === id)?.name ||
																			"Teammate",
																	)
																	.join(", ")}
															</p>
														)}
														{canEdit && (
															<button
																type="button"
																className="btn btn-ghost btn-xs mt-2"
																onClick={() => {
																	setParentId(comment.id);
																	setEditComment(null);
																	setBody("");
																	setSelection(emptySelection());
																}}
															>
																Reply
															</button>
														)}
													</>
												)}
												{!comment.deleted &&
													canEdit &&
													(comment.authorId === currentUser.id ||
														currentUser.role === "admin") && (
														<div className="task-comment-actions">
															{deleteId === comment.id ? (
																<>
																	<span>Delete this comment?</span>
																	<button
																		className="btn btn-error btn-xs"
																		disabled={busy || conflict}
																		onClick={() => mutation.mutate("delete")}
																	>
																		<ActionIcon name="trash" />
																		Delete comment
																	</button>
																	<button
																		className="btn btn-ghost btn-xs"
																		disabled={busy}
																		onClick={() => setDeleteId("")}
																	>
																		Cancel
																	</button>
																</>
															) : (
																<>
																	<button
																		className="btn btn-ghost btn-xs"
																		aria-label="Edit comment"
																		disabled={busy || conflict}
																		onClick={() => {
																			setEditComment({
																				id: comment.id,
																				revision: comment.revision,
																			});
																			setBody(comment.body);
																			setParentId(comment.parentId);
																			setSelection({
																				mentionIds: [...comment.mentionIds],
																				references: [...comment.references],
																				responseRecipientIds: [
																					...comment.responseRecipientIds,
																				],
																			});
																			setDeleteId("");
																			setError("");
																		}}
																	>
																		<ActionIcon name="edit" />
																		Edit
																	</button>
																	<button
																		className="btn btn-ghost btn-xs"
																		aria-label="Delete comment"
																		disabled={busy || conflict}
																		onClick={() => {
																			setDeleteId(comment.id);
																			setError("");
																		}}
																	>
																		<ActionIcon name="trash" />
																		Delete
																	</button>
																</>
															)}
														</div>
													)}
											</article>
										))}
									</div>
									{canEdit ? (
										<>
											{savedConversation && (
												<ConversationReceipt
													source={savedConversation}
													members={members}
												/>
											)}
											<ConversationComposer
												key={
													editComment
														? `edit:${editComment.id}`
														: `reply:${parentId}`
												}
												className="task-comment-composer"
												label={
													editComment
														? "Edit comment"
														: parentId
															? "Reply to comment"
															: "Add a comment"
												}
												body={body}
												onBodyChange={setBody}
												projectId={task.projectId}
												replyTo={
													replyParent && {
														memberId: replyParent.authorId,
														name: replyParent.authorName,
													}
												}
												members={members}
												selection={selection}
												onSelectionChange={setSelection}
												disabled={busy}
												submitDisabled={conflict}
												submitLabel={
													mutation.isPending
														? "Saving…"
														: editComment
															? "Save comment"
															: "Post comment"
												}
												onSubmit={() => {
													setSavedConversation(null);
													mutation.mutate("save");
												}}
											>
												{parentId && !editComment && (
													<button
														type="button"
														className="btn btn-ghost btn-sm"
														disabled={busy}
														onClick={() => {
															setParentId("");
															setBody("");
															setSelection(emptySelection());
														}}
													>
														Cancel reply
													</button>
												)}
												{editComment && (
													<button
														type="button"
														className="btn btn-ghost btn-sm"
														disabled={busy}
														onClick={() => {
															setEditComment(null);
															setParentId("");
															setSelection(emptySelection());
															setBody("");
															setError("");
															setConflict(false);
														}}
													>
														Cancel edit
													</button>
												)}
											</ConversationComposer>
										</>
									) : (
										<p className="task-discussion-empty">
											You have read-only access to this discussion.
										</p>
									)}
								</>
							)}
							{discussion.data && tab === "activity" && (
								<>
									{!discussion.data.activity.length && (
										<p className="task-discussion-empty">
											No task activity recorded yet.
										</p>
									)}
									<ol className="task-activity-list">
										{discussion.data.activity.map((event) => (
											<li key={event.id}>
												<span
													className="task-activity-dot"
													aria-hidden="true"
												/>
												<div>
													<p>{event.summary}</p>
													<small>
														{event.actorName || "Unknown author"}
														{event.actorKind === "agent" ? " (agent)" : ""} ·{" "}
														{time(event.occurredAt)}
													</small>
												</div>
											</li>
										))}
									</ol>
								</>
							)}
						</section>
					</section>
					<aside className="task-properties" aria-label="Task properties">
						<h3>Properties</h3>
						<dl>
							{[
								["Column", task.column],
								[
									"Owner",
									members.find((m) => m.id === task.assigneeId)?.name ||
										(task.assigneeId ? "Assigned teammate" : "Unassigned"),
								],
								["Priority", task.priority],
								["Due date", task.dueDate || "No date"],
							].map(([label, value]) => (
								<div key={label}>
									<dt>{label}</dt>
									<dd>{value}</dd>
								</div>
							))}
						</dl>
						{canReadReports && (
							<section className="task-linked-reports">
								<h3>Linked research</h3>
								{reports.isPending ? (
									<p>Loading reports…</p>
								) : reports.isError ? (
									<p role="alert">
										Could not load reports.{" "}
										<button
											className="link"
											onClick={() => void reports.refetch()}
										>
											Retry
										</button>
									</p>
								) : reports.data?.length ? (
									<ul>
										{reports.data.map((r) => (
											<li key={r.id}>
												<button
													className="link text-left"
													onClick={() =>
														setReportId(reportId === r.id ? "" : r.id)
													}
												>
													{r.title}
												</button>
											</li>
										))}
									</ul>
								) : (
									<p>No reports linked to this task.</p>
								)}
							</section>
						)}
					</aside>
				</div>
				{reportId && canReadReports && (
					<section className="task-linked-report-reader">
						<button
							className="btn btn-ghost btn-sm float-right"
							onClick={() => setReportId("")}
						>
							<ActionIcon name="close" />
							Close report
						</button>
						{report.isPending ? (
							<p>Loading report…</p>
						) : report.isError ? (
							<p role="alert">{report.error.message}</p>
						) : (
							report.data?.report && (
								<>
									<h3>{report.data.report.title}</h3>
									<p>{report.data.report.summary}</p>
									<div className="whitespace-pre-wrap mt-4">
										{report.data.report.body}
									</div>
								</>
							)
						)}
					</section>
				)}
			</div>
			<form
				method="dialog"
				className="modal-backdrop"
				onSubmit={(event) => {
					event.preventDefault();
					if (!busy) onClose();
				}}
			>
				<button aria-label="Close task details" disabled={busy}>
					Close
				</button>
			</form>
		</dialog>
	);
}
