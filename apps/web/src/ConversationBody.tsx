import type { ReactNode } from "react";
import type { Member } from "./api";
import { memberIdentity } from "./ConversationFields";
import {
	emailRanges,
	mentionStarts,
	nameAtStart,
} from "./conversationMentions";

// Text alone never establishes identity. Only highlight names backed by saved
// recipient IDs; retain recipient chips when a historical name no longer matches.
export default function ConversationBody({
	body,
	members,
	mentionIds,
	responseRecipientIds,
}: {
	body: string;
	members: Member[];
	mentionIds: string[];
	responseRecipientIds: string[];
}) {
	const linked = new Set([...mentionIds, ...responseRecipientIds]);
	const recipients = members.filter((member) => linked.has(member.id));
	const emails = emailRanges(body);
	const content: ReactNode[] = [];
	let cursor = 0;
	for (const start of mentionStarts(body)) {
		if (
			start < cursor ||
			emails.some((email) => start >= email.start && start < email.end)
		)
			continue;
		// Match the longest known name first, including unlinked members, so a
		// short linked name cannot falsely highlight part of someone else's name.
		const known = nameAtStart(body.slice(start + 1), members);
		if (!known) continue;
		const matches = recipients.filter(
			(member) =>
				member.name.toLocaleLowerCase() === known.name.toLocaleLowerCase(),
		);
		if (!matches.length) continue;
		const end = start + known.name.length + 1;
		content.push(body.slice(cursor, start));
		content.push(
			<mark
				key={start}
				data-member-ids={matches.map((member) => member.id).join(" ")}
				className="rounded bg-primary/15 px-1 font-medium text-primary box-decoration-clone"
				title={matches
					.map(
						(member) =>
							`${member.name} · ${memberIdentity(member, members)} · ${responseRecipientIds.includes(member.id) ? "Response requested" : "FYI"}`,
					)
					.join("; ")}
			>
				{body.slice(start, end)}
			</mark>,
		);
		cursor = end;
	}
	content.push(body.slice(cursor));
	return <>{content}</>;
}
