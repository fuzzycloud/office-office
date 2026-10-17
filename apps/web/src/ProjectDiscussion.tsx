import { useSourceAnchor } from "./SourceLink";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
	createTaskFromMessage,
	deleteProjectMessage,
	listProjectDiscussion,
	saveProjectMessage,
	type Board,
	type Member,
} from "./api";
import {
	emptySelection,
	ReferenceLinks,
	sourceHref,
} from "./ConversationFields";

import ConversationComposer from "./ConversationComposer";
import ConversationReceipt, {
	type SavedConversation,
} from "./ConversationReceipt";

export default function ProjectDiscussion({
	projectId,
	members,
	boards,
	canEdit,
	canConvert,
	currentUser,
}: {
	projectId: string;
	members: Member[];
	boards: Board[];
	canEdit: boolean;
	canConvert: boolean;
	currentUser: Member;
}) {
	const cache = useQueryClient();
	const boardFieldId = useId();
	const [body, setBody] = useState("");
	const [savedConversation, setSavedConversation] =
		useState<SavedConversation | null>(null);
	const [parentId, setParentId] = useState("");
	const [edit, setEdit] = useState<{ id: string; revision: number } | null>(
		null,
	);
	const [deleteId, setDeleteId] = useState("");
	const [selection, setSelection] = useState(emptySelection);
	const [convert, setConvert] = useState("");
	const [title, setTitle] = useState("");
	const [boardId, setBoardId] = useState(boards[0]?.id || "");
	const discussion = useQuery({
		queryKey: ["project-discussion", projectId],
		queryFn: () => listProjectDiscussion(projectId),
		retry: false,
		refetchInterval: 20000,
	});
	const refresh = async () => {
		await Promise.all([
			cache.invalidateQueries({ queryKey: ["project-discussion", projectId] }),
			cache.invalidateQueries({ queryKey: ["notifications"] }),
			cache.invalidateQueries({ queryKey: ["workspace"] }),
		]);
	};
	const save = useMutation({
		mutationFn: () =>
			saveProjectMessage(
				{
					id: edit?.id,
					projectId,
					body: body.trim(),
					parentId,
					...selection,
				},
				edit?.revision || 0,
			),
		onSuccess: async (result) => {
			if (result.message)
				setSavedConversation({
					kind: "project_message",
					id: result.message.id,
					revision: result.message.revision,
					unchanged: edit?.revision === result.message.revision,
				});
			setBody("");
			setEdit(null);
			setParentId("");
			setSelection(emptySelection());
			await refresh();
		},
	});
	const task = useMutation({
		mutationFn: () => {
			const message = discussion.data?.messages.find((m) => m.id === convert);
			const board = boards.find((b) => b.id === boardId);
			if (!message || !board)
				throw new Error("Choose a board before creating the task.");
			return createTaskFromMessage(message.id, message.revision, {
				id: "",
				projectId,
				boardId: board.id,
				column: board.columns[0],
				title: title.trim(),
				description: message.body,
				assigneeId: "",
				priority: "medium",
				dueDate: "",
			});
		},
		onSuccess: async () => {
			setConvert("");
			await refresh();
		},
	});
	const remove = useMutation({
		mutationFn: () => {
			const message = discussion.data?.messages.find((m) => m.id === deleteId);
			if (!message) throw new Error("Refresh the discussion before deleting.");
			return deleteProjectMessage(message.id, message.revision);
		},
		onSuccess: async () => {
			setDeleteId("");
			await refresh();
		},
	});
	const busy = save.isPending || task.isPending || remove.isPending;
	useSourceAnchor(discussion.data);
	return (
		<section
			className="mt-6 rounded-box border border-base-300 bg-base-100 p-4 sm:p-6 min-w-0"
			aria-label="Project discussion"
		>
			<div className="flex justify-between gap-3">
				<div>
					<h3 className="text-xl font-semibold">Project discussion</h3>
					<p className="text-sm text-base-content/65">
						Questions and context shared across this project.
					</p>
				</div>
				<button
					className="btn btn-ghost btn-sm"
					disabled={discussion.isFetching}
					onClick={() => void discussion.refetch()}
				>
					Refresh discussion
				</button>
			</div>
			{discussion.isPending && (
				<p role="status" className="py-4">
					Loading discussion…
				</p>
			)}
			{discussion.isError && (
				<p role="alert" className="text-error">
					{discussion.error.message}
				</p>
			)}
			<div className="divide-y divide-base-300 mt-3">
				{discussion.data?.messages.map((message) => (
					<article
						key={message.id}
						id={`source-project_message-${message.id}`}
						className={`py-4 ${message.parentId ? "ml-4 border-l-2 border-base-300 pl-3" : ""}`}
					>
						<p className="text-sm text-base-content/65">
							{message.parentId && (
								<a
									className="link"
									href={`#source-project_message-${message.parentId}`}
								>
									Reply to{" "}
									{discussion.data?.messages.find(
										(m) => m.id === message.parentId,
									)?.authorName || "earlier message"}
								</a>
							)}
							<strong>{message.authorName}</strong>{" "}
							{message.actorKind === "agent" ? "(AI)" : ""} ·{" "}
							{new Date(Number(message.createdAt) * 1000).toLocaleString()}
						</p>
						<p className="whitespace-pre-wrap break-words mt-1">
							{message.deleted ? "Message deleted" : message.body}
						</p>
						{!message.deleted && (
							<>
								<p className="text-sm text-base-content/65">
									{message.mentionIds
										.map(
											(id) =>
												`@${members.find((m) => m.id === id)?.name || "Teammate"}`,
										)
										.join(" ")}
								</p>
								<ReferenceLinks references={message.references} />
								{message.responseRecipientIds.length > 0 && (
									<p className="text-xs text-warning">
										Response requested from{" "}
										{message.responseRecipientIds
											.map(
												(id) =>
													members.find((m) => m.id === id)?.name || "Teammate",
											)
											.join(", ")}
									</p>
								)}
								<div className="flex flex-wrap gap-2 mt-2">
									{canEdit && (
										<button
											className="btn btn-ghost btn-xs"
											onClick={() => {
												setEdit(null);
												setParentId(message.id);
												setBody("");
												setSelection(emptySelection());
											}}
										>
											Reply
										</button>
									)}
									{canEdit &&
										(message.authorId === currentUser.id ||
											currentUser.role === "admin") && (
											<>
												{deleteId === message.id ? (
													<>
														<span className="text-sm">
															Delete this message?
														</span>
														<button
															className="btn btn-error btn-xs"
															disabled={busy}
															onClick={() => remove.mutate()}
														>
															Confirm delete message
														</button>
														<button
															className="btn btn-ghost btn-xs"
															onClick={() => setDeleteId("")}
														>
															Keep message
														</button>
													</>
												) : (
													<>
														<button
															className="btn btn-ghost btn-xs"
															disabled={busy}
															onClick={() => {
																setEdit({
																	id: message.id,
																	revision: message.revision,
																});
																setBody(message.body);
																setParentId(message.parentId);
																setSelection({
																	mentionIds: [...message.mentionIds],
																	references: [...message.references],
																	responseRecipientIds: [
																		...message.responseRecipientIds,
																	],
																});
																save.reset();
															}}
														>
															Edit message
														</button>
														<button
															className="btn btn-ghost btn-xs"
															disabled={busy}
															onClick={() => setDeleteId(message.id)}
														>
															Delete message
														</button>
													</>
												)}
											</>
										)}
									{message.linkedTaskId ? (
										<a
											href={sourceHref("task", message.linkedTaskId)}
											className="link text-sm"
										>
											Open created task
										</a>
									) : (
										canConvert && (
											<button
												className="btn btn-outline btn-xs"
												onClick={() => {
													setConvert(message.id);
													setTitle(message.body.split("\n")[0].slice(0, 200));
													task.reset();
												}}
											>
												Create task from message
											</button>
										)
									)}
								</div>
							</>
						)}
					</article>
				))}
			</div>
			{remove.isError && (
				<p role="alert" className="text-error">
					{remove.error.message}
				</p>
			)}
			{discussion.data?.messages.length === 0 && (
				<p className="py-4 text-sm text-base-content/65">
					No messages yet. Share project context or ask a question.
				</p>
			)}
			{convert && (
				<form
					aria-label="Create task from message"
					className="rounded-box border border-base-300 p-3 grid gap-3 my-3"
					onSubmit={(event) => {
						event.preventDefault();
						task.mutate();
					}}
				>
					<label className="grid gap-1 text-sm">
						Task title
						<input
							className="input input-bordered w-full"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							required
							maxLength={200}
						/>
					</label>
					<div className="grid gap-1 text-sm">
						<label htmlFor={boardFieldId}>Task board</label>
						<select
							id={boardFieldId}
							className="select select-bordered w-full"
							value={boardId}
							onChange={(event) => setBoardId(event.target.value)}
							required
						>
							<option value="">Choose board</option>
							{boards.map((b) => (
								<option key={b.id} value={b.id}>
									{b.name}
								</option>
							))}
						</select>
					</div>
					{!boards.length && (
						<p className="text-sm">Create a project board first.</p>
					)}
					{task.isError && (
						<p role="alert" className="text-error">
							{task.error.message}
						</p>
					)}
					<div className="flex gap-2">
						<button
							className="btn btn-primary btn-sm"
							disabled={busy || !title.trim() || !boardId}
						>
							Create task
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() => setConvert("")}
						>
							Cancel
						</button>
					</div>
				</form>
			)}
			{canEdit && (
				<>
					{savedConversation && (
						<ConversationReceipt source={savedConversation} members={members} />
					)}
					{save.isError && (
						<p role="alert" className="text-error">
							{save.error.message} Your draft is preserved.
						</p>
					)}
					<ConversationComposer
						key={edit ? `edit:${edit.id}` : `reply:${parentId}`}
						className="mt-4 grid gap-2"
						label={
							edit
								? "Edit project message"
								: parentId
									? "Reply to project message"
									: "Add project message"
						}
						body={body}
						onBodyChange={setBody}
						projectId={projectId}
						members={members}
						selection={selection}
						onSelectionChange={setSelection}
						disabled={busy}
						submitLabel={
							save.isPending
								? "Saving…"
								: edit
									? "Save message"
									: "Post message"
						}
						onSubmit={() => {
							setSavedConversation(null);
							save.mutate();
						}}
					>
						{(parentId || edit) && (
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								disabled={busy}
								onClick={() => {
									setEdit(null);
									setParentId("");
									setBody("");
									setSelection(emptySelection());
									save.reset();
								}}
							>
								Cancel {edit ? "edit" : "reply"}
							</button>
						)}
					</ConversationComposer>
				</>
			)}
		</section>
	);
}
