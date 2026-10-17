import { type ReactNode, useId, useRef, useState } from "react";
import type { Member } from "./api";
import ConversationFields, {
	type ConversationSelection,
	MemberOptions,
	matchingMembers,
	selectRecipient,
} from "./ConversationFields";

type MentionToken = { start: number; end: number; query: string };

// A name is a notification target only after the author picks its stable ID.
// These helpers recognize text for warnings and search, never to add recipients.
function mentionStarts(body: string) {
	return [...body.matchAll(/(^|[\s([{<"'“‘,:;!?])@/gu)].map(
		(match) => (match.index ?? 0) + match[1].length,
	);
}

function emailRanges(body: string) {
	return [...body.matchAll(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/gu)].map(
		(match) => ({
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length,
		}),
	);
}

function nameAtStart(text: string, members: Member[]) {
	const lower = text.toLocaleLowerCase();
	return members
		.filter((member) => {
			if (!member.name || !lower.startsWith(member.name.toLocaleLowerCase()))
				return false;
			const next = text[member.name.length];
			if (
				next &&
				[".", "'", "’"].includes(next) &&
				/[\p{L}\p{N}]/u.test(text[member.name.length + 1] || "")
			)
				return false;
			return !next || /[\s.,;:!?()[\]{}<>"'“”‘’]/u.test(next);
		})
		.sort((left, right) => right.name.length - left.name.length)[0];
}

export function unlinkedMentionNames(
	body: string,
	members: Member[],
	selection: ConversationSelection,
) {
	const emails = emailRanges(body);
	const active = members.filter((member) => member.status === "active");
	const linked = new Set([
		...selection.mentionIds,
		...selection.responseRecipientIds,
	]);
	const names: string[] = [];
	let recognizedThrough = 0;
	for (const start of mentionStarts(body)) {
		if (start < recognizedThrough) continue;
		if (emails.some((email) => start >= email.start && start < email.end))
			continue;
		const tail = body.slice(start + 1);
		const known = nameAtStart(tail, active);
		if (known) recognizedThrough = start + 1 + known.name.length;
		if (
			known &&
			active.some(
				(member) =>
					member.name.toLocaleLowerCase() === known.name.toLocaleLowerCase() &&
					linked.has(member.id),
			)
		)
			continue;
		const token =
			known?.name ||
			tail.match(/^[^\s@]+/u)?.[0]?.replace(/[.,;:!?()[\]{}<>"'“”‘’]+$/u, "");
		// A bare @ is still an unfinished mention and needs an explicit decision.
		names.push(`@${token || ""}`);
	}
	return [...new Set(names)];
}

function mentionAtCursor(
	body: string,
	cursor: number,
	members: Member[],
	selection: ConversationSelection,
): MentionToken | null {
	const start = mentionStarts(body.slice(0, cursor)).at(-1);
	if (start === undefined) return null;
	const query = body.slice(start + 1, cursor);
	if (/[\n\r@]/u.test(query)) return null;
	const linked = new Set([
		...selection.mentionIds,
		...selection.responseRecipientIds,
	]);
	const selected = nameAtStart(
		query,
		members.filter(
			(member) => member.status === "active" && linked.has(member.id),
		),
	);
	if (selected && query.length > selected.name.length) return null;
	if (
		emailRanges(body).some((email) => start >= email.start && start < email.end)
	)
		return null;
	const known = nameAtStart(
		body.slice(start + 1),
		members.filter((member) => member.status === "active"),
	);
	const suffix =
		body.slice(cursor).match(/^[^\s@.,;:!?()[\]{}<>"'“”‘’]*/u)?.[0].length || 0;
	return {
		start,
		end: known ? start + 1 + known.name.length : cursor + suffix,
		query,
	};
}

export type ConversationComposerProps = {
	label: string;
	body: string;
	onBodyChange: (body: string) => void;
	members: Member[];
	selection: ConversationSelection;
	onSelectionChange: (value: ConversationSelection) => void;
	projectId: string;
	disabled: boolean;
	selectionDisabled?: boolean;
	submitDisabled?: boolean;
	submitLabel: string;
	onSubmit: () => void;
	children?: ReactNode;
	className?: string;
};

export default function ConversationComposer({
	label,
	body,
	onBodyChange,
	members,
	selection,
	onSelectionChange,
	projectId,
	disabled,
	selectionDisabled = false,
	submitDisabled = false,
	submitLabel,
	onSubmit,
	children,
	className,
}: ConversationComposerProps) {
	const id = useId();
	const listId = `${id}-suggestions`;
	const textarea = useRef<HTMLTextAreaElement>(null);
	const [token, setToken] = useState<MentionToken | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const [error, setError] = useState("");
	// Associate acknowledgement with the exact draft, including linked IDs and
	// reference changes, so an external update cannot reuse an old acknowledgement.
	const draftKey = JSON.stringify([body, selection]);
	const [acknowledgedDraft, setAcknowledgedDraft] = useState<string | null>(
		null,
	);
	const unlinked = unlinkedMentionNames(body, members, selection);
	const unavailableRecipients = [
		...new Set([...selection.mentionIds, ...selection.responseRecipientIds]),
	].filter(
		(memberId) =>
			!members.some(
				(member) => member.id === memberId && member.status === "active",
			),
	);
	const acknowledged = acknowledgedDraft === draftKey;
	const matches = matchingMembers(members, token?.query || "");
	const pickerOpen = !!token && !disabled && !selectionDisabled;
	const selectedIndex = Math.min(activeIndex, matches.length - 1);

	const updateToken = (nextBody: string, cursor: number) => {
		setToken(
			selectionDisabled
				? null
				: mentionAtCursor(nextBody, cursor, members, selection),
		);
		setActiveIndex(0);
	};
	const changeBody = (nextBody: string) => {
		setAcknowledgedDraft(null);
		setError("");
		onBodyChange(nextBody);
	};
	const changeSelection = (nextSelection: ConversationSelection) => {
		setAcknowledgedDraft(null);
		setError("");
		onSelectionChange(nextSelection);
	};
	const chooseMember = (member: Member) => {
		if (!token || disabled || selectionDisabled) return;
		const nextBody = `${body.slice(0, token.start)}@${member.name} ${body.slice(token.end)}`;
		const cursor = token.start + member.name.length + 2;
		changeBody(nextBody);
		// A prior, explicit response request remains a response request.
		if (!selection.responseRecipientIds.includes(member.id)) {
			changeSelection(selectRecipient(selection, "mentionIds", member.id));
		}
		setToken(null);
		requestAnimationFrame(() => {
			textarea.current?.focus();
			textarea.current?.setSelectionRange(cursor, cursor);
		});
	};

	return (
		<form
			className={className}
			onSubmit={(event) => {
				event.preventDefault();
				if (disabled || submitDisabled) return;
				if (!body.trim()) {
					setError("Write a message before posting.");
					return;
				}
				if (new TextEncoder().encode(body.trim()).length > 10000) {
					setError(
						"Keep the message within 10,000 bytes. Shorten the text and try again.",
					);
					return;
				}
				if (unavailableRecipients.length) {
					setError("Remove inactive or unavailable recipients before posting.");
					return;
				}
				if (unlinked.length && !acknowledged) {
					setError(
						"Choose recipients for the typed names, or confirm that you want to post without notifying them.",
					);
					return;
				}
				setError("");
				setToken(null);
				onSubmit();
			}}
		>
			<label
				htmlFor={`${id}-body`}
				className="block label-text font-medium mb-2"
			>
				{label}
			</label>
			<div className="relative min-w-0">
				<textarea
					ref={textarea}
					id={`${id}-body`}
					className="textarea textarea-bordered w-full min-h-28"
					value={body}
					onChange={(event) => {
						changeBody(event.target.value);
						updateToken(event.target.value, event.target.selectionStart);
					}}
					onClick={(event) =>
						updateToken(body, event.currentTarget.selectionStart)
					}
					onKeyUp={(event) => {
						if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
							updateToken(body, event.currentTarget.selectionStart);
					}}
					onBlur={() => setToken(null)}
					onKeyDown={(event) => {
						if (!pickerOpen || event.nativeEvent.isComposing) return;
						if (event.key === "Escape") {
							event.preventDefault();
							setToken(null);
						}
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							setActiveIndex((index) =>
								matches.length
									? (index +
											(event.key === "ArrowDown" ? 1 : -1) +
											matches.length) %
										matches.length
									: 0,
							);
						}
						if (event.key === "Enter" && matches[selectedIndex]) {
							event.preventDefault();
							chooseMember(matches[selectedIndex]);
						}
					}}
					disabled={disabled}
					required
					maxLength={10000}
					placeholder="Share context with the team. Type @ to choose a teammate."
					aria-autocomplete="list"
					aria-haspopup="listbox"
					aria-controls={pickerOpen ? listId : undefined}
					aria-activedescendant={
						pickerOpen && matches.length
							? `${listId}-${selectedIndex}`
							: undefined
					}
					aria-describedby={`${id}-hint${unlinked.length ? ` ${id}-unlinked` : ""}${error ? ` ${id}-error` : ""}`}
					aria-invalid={!!error}
				/>
				{pickerOpen && (
					<div className="absolute inset-x-0 top-full z-30 mt-1 grid max-h-[min(20rem,45vh)] gap-1 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
						<p className="text-xs text-base-content/70">
							Choose Mention / FYI · use ↑ ↓ and Enter, or tap a teammate.
							Escape closes.
						</p>
						<MemberOptions
							members={matches}
							allMembers={members}
							listId={listId}
							activeIndex={selectedIndex}
							onActiveIndexChange={setActiveIndex}
							onSelect={chooseMember}
						/>
					</div>
				)}
			</div>
			<p id={`${id}-hint`} className="text-xs text-base-content/70 mt-1">
				Choose a teammate to link an @mention. Typing a name alone does not
				notify them.
			</p>
			<ConversationFields
				members={members}
				value={selection}
				onChange={changeSelection}
				projectId={projectId}
				disabled={disabled || selectionDisabled}
			/>
			{unavailableRecipients.length > 0 && (
				<p role="alert" className="text-error text-sm mt-2">
					Remove inactive or unavailable recipients before posting.
				</p>
			)}
			{unlinked.length > 0 && (
				<div
					id={`${id}-unlinked`}
					className="rounded-box border border-warning/50 bg-warning/10 p-3 grid gap-2 mt-3"
				>
					<p className="text-sm break-words">
						These typed names are not linked to active selected recipients:{" "}
						{unlinked.join(", ")}. Choose them above to notify them.
					</p>
					<label className="flex gap-2 items-start text-sm">
						<input
							type="checkbox"
							className="checkbox checkbox-sm mt-0.5 shrink-0"
							checked={acknowledged}
							disabled={disabled}
							onChange={(event) =>
								setAcknowledgedDraft(event.target.checked ? draftKey : null)
							}
						/>
						<span>Post without notifying these names</span>
					</label>
				</div>
			)}
			{error && (
				<p id={`${id}-error`} role="alert" className="text-error text-sm mt-2">
					{error}
				</p>
			)}
			<div className="flex flex-wrap justify-end gap-2 mt-3">
				{children}
				<button
					className="btn btn-primary btn-sm"
					type="submit"
					disabled={disabled || submitDisabled || !body.trim()}
				>
					{submitLabel}
				</button>
			</div>
		</form>
	);
}
