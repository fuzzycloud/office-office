import { useQuery } from "@tanstack/react-query";
import {
	listNotifications,
	listProjectDiscussion,
	listTaskDiscussion,
	type Member,
} from "./api";
import { memberIdentity, sourceHref } from "./ConversationFields";

export type SavedConversation = {
	kind: "task_comment" | "project_message";
	id: string;
	revision: number;
	unchanged?: boolean;
	contextId: string;
	expected: {
		mentionIds: string[];
		responseRecipientIds: string[];
		parentId: string;
	};
	previous?: { mentionIds: string[]; responseRecipientIds: string[] };
	replyRecipientId: string;
};

async function readReceipt(source: SavedConversation) {
	const record =
		source.kind === "task_comment"
			? (await listTaskDiscussion(source.contextId)).comments.find(
					(record) => record.id === source.id,
				)
			: (await listProjectDiscussion(source.contextId)).messages.find(
					(record) => record.id === source.id,
				);
	if (!record || record.deleted || record.revision !== source.revision)
		throw new Error(
			"The saved revision is no longer current. Open the saved discussion to inspect its latest state.",
		);
	const notices = new Set<string>();
	const responses = new Set<string>();
	const deliveries = new Set<string>();
	const seenNotificationIds = new Set<string>();
	let duplicateDelivery = false;
	let offset = 0;
	// A no-op returns the original revision; its notifications predate this save.
	if (!source.unchanged)
		do {
			const page = await listNotifications({
				scope: "sent",
				status: "",
				pageSize: 100,
				offset,
			});
			for (const notification of page.notifications) {
				if (
					notification.sourceKind !== source.kind ||
					notification.sourceId !== source.id ||
					notification.sourceRevision !== source.revision
				)
					continue;
				// Offset pages can overlap when newer notifications arrive between reads.
				// Only distinct records with the same delivery represent a duplicate.
				if (seenNotificationIds.has(notification.id)) continue;
				seenNotificationIds.add(notification.id);
				const delivery = `${notification.kind}:${notification.recipientId}`;
				if (deliveries.has(delivery)) duplicateDelivery = true;
				deliveries.add(delivery);
				if (notification.kind === "notice")
					notices.add(notification.recipientId);
				if (notification.kind === "response_request")
					responses.add(notification.recipientId);
			}
			offset = page.nextOffset;
		} while (offset);
	const sameIds = (left: string[], right: string[]) => {
		const sortedRight = [...right].sort();
		return (
			left.length === right.length &&
			[...left].sort().every((id, index) => id === sortedRight[index])
		);
	};
	const expectedNotices = source.unchanged
		? []
		: source.expected.mentionIds.filter(
				(id) => !source.previous?.mentionIds.includes(id),
			);
	const expectedResponses = source.unchanged
		? []
		: source.expected.responseRecipientIds.filter(
				(id) => !source.previous?.responseRecipientIds.includes(id),
			);
	// Only newly added recipients emit again on an edit. New replies can also
	// inform their active parent author without an explicit recipient chip.
	if (
		!source.unchanged &&
		source.revision === 1 &&
		source.replyRecipientId &&
		!source.expected.mentionIds.includes(source.replyRecipientId) &&
		!source.expected.responseRecipientIds.includes(source.replyRecipientId)
	)
		expectedNotices.push(source.replyRecipientId);
	return {
		persistedNotices: record.mentionIds,
		persistedResponses: record.responseRecipientIds,
		notices: [...notices],
		responses: [...responses],
		persistedMismatch:
			!sameIds(record.mentionIds, source.expected.mentionIds) ||
			!sameIds(
				record.responseRecipientIds,
				source.expected.responseRecipientIds,
			) ||
			record.parentId !== source.expected.parentId,
		emissionMismatch:
			duplicateDelivery ||
			!sameIds([...notices], expectedNotices) ||
			!sameIds([...responses], expectedResponses),
	};
}

export default function ConversationReceipt({
	source,
	members,
}: {
	source: SavedConversation;
	members: Member[];
}) {
	const receipt = useQuery({
		queryKey: ["conversation-receipt", source],
		queryFn: () => readReceipt(source),
		retry: false,
		staleTime: Infinity,
	});
	const mismatch =
		receipt.data?.persistedMismatch || receipt.data?.emissionMismatch;
	const retryVerification = (
		<button
			type="button"
			className="link"
			disabled={receipt.isFetching}
			onClick={() => void receipt.refetch()}
		>
			Retry verification
		</button>
	);
	const names = (ids: string[]) =>
		ids
			.map((id) => {
				const member = members.find((candidate) => candidate.id === id);
				if (!member) return id;
				const duplicate = members.some(
					(other) =>
						other.id !== id &&
						other.name.toLocaleLowerCase() === member.name.toLocaleLowerCase(),
				);
				return `${member.name}${duplicate ? ` (${memberIdentity(member, members)})` : member.kind === "agent" ? " (AI)" : ""}`;
			})
			.join(", ");
	return (
		<div
			role="status"
			aria-label="Notification receipt"
			className="rounded-box border border-base-300 bg-base-200 p-3 text-sm grid gap-1 mt-3 min-w-0 break-words"
		>
			<p className="font-medium">
				Saved.{" "}
				<a
					className="link"
					href={sourceHref(source.kind, source.id, source.revision)}
				>
					View saved {source.kind === "task_comment" ? "comment" : "message"}
				</a>
			</p>
			{receipt.isPending && <p>Checking notification recipients…</p>}
			{receipt.isError && (
				<p>
					Your message is saved, but notification recipients could not be
					verified. {receipt.error.message} {retryVerification}
				</p>
			)}
			{receipt.data && !receipt.isError && (
				<>
					{mismatch && (
						<div
							role="alert"
							className="border-l-4 border-warning pl-3 grid gap-1"
						>
							<p className="font-semibold">Recipient verification mismatch</p>
							{receipt.data.persistedMismatch && (
								<p>
									The saved recipients or reply reference differ from your
									selection. Open the saved discussion before making a
									correction.
								</p>
							)}
							{receipt.data.persistedMismatch && (
								<p>
									Saved FYI: {names(receipt.data.persistedNotices) || "Nobody"}.
									Saved response requests:{" "}
									{names(receipt.data.persistedResponses) || "Nobody"}.
								</p>
							)}
							{receipt.data.emissionMismatch && (
								<p>
									The notification records do not match the expected recipients
									and modes for this save.
								</p>
							)}
							<p>
								Selected FYI: {names(source.expected.mentionIds) || "Nobody"}.
								Selected response requests:{" "}
								{names(source.expected.responseRecipientIds) || "Nobody"}.
							</p>
							<p>Do not post again to retry delivery. {retryVerification}</p>
						</div>
					)}
					{receipt.data.notices.length > 0 && (
						<p>Mention / FYI notified: {names(receipt.data.notices)}.</p>
					)}
					{receipt.data.responses.length > 0 && (
						<p>Response requested from: {names(receipt.data.responses)}.</p>
					)}
					{!receipt.data.notices.length && !receipt.data.responses.length && (
						<p className="font-medium">
							No new notifications were created.
							{!mismatch &&
								(source.expected.mentionIds.length ||
								source.expected.responseRecipientIds.length
									? " Existing recipients were not notified again."
									: " Nobody was notified by this save.")}
						</p>
					)}
					<p className="text-base-content/65">
						Notification creation does not mean the recipient has read it or
						started work.
					</p>
				</>
			)}
		</div>
	);
}
