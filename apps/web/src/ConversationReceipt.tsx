import { useQuery } from "@tanstack/react-query";
import { listNotifications, type Member } from "./api";
import { memberIdentity, sourceHref } from "./ConversationFields";

export type SavedConversation = {
	kind: "task_comment" | "project_message";
	id: string;
	revision: number;
	unchanged?: boolean;
};

async function readReceipt(source: SavedConversation) {
	const notices = new Set<string>();
	const responses = new Set<string>();
	let offset = 0;
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
			if (notification.kind === "notice") notices.add(notification.recipientId);
			if (notification.kind === "response_request")
				responses.add(notification.recipientId);
		}
		offset = page.nextOffset;
	} while (offset);
	return { notices: [...notices], responses: [...responses] };
}

export default function ConversationReceipt({
	source,
	members,
}: {
	source: SavedConversation;
	members: Member[];
}) {
	const receipt = useQuery({
		queryKey: ["conversation-receipt", source.kind, source.id, source.revision],
		queryFn: () => readReceipt(source),
		enabled: !source.unchanged,
		retry: false,
		staleTime: Infinity,
	});
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
			{source.unchanged && <p>No new notifications were created.</p>}
			{!source.unchanged && receipt.isPending && (
				<p>Checking notification recipients…</p>
			)}
			{!source.unchanged && receipt.isError && (
				<p>
					Your message is saved, but notification recipients could not be
					verified.{" "}
					<button
						type="button"
						className="link"
						onClick={() => void receipt.refetch()}
					>
						Retry verification
					</button>
				</p>
			)}
			{!source.unchanged && receipt.data && (
				<>
					{receipt.data.notices.length > 0 && (
						<p>Mention / FYI notified: {names(receipt.data.notices)}.</p>
					)}
					{receipt.data.responses.length > 0 && (
						<p>Response requested from: {names(receipt.data.responses)}.</p>
					)}
					{!receipt.data.notices.length && !receipt.data.responses.length && (
						<p>No new notifications were created.</p>
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
