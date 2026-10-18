import {
	autoUpdate,
	flip,
	offset,
	shift,
	size,
	useFloating,
} from "@floating-ui/react";
import {
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { Member } from "./api";
import ConversationFields, {
	type ConversationSelection,
	MemberOptions,
	matchingMembers,
	memberIdentity,
	type RecipientIntent,
	selectRecipient,
} from "./ConversationFields";
import {
	emailRanges,
	mentionStarts,
	nameAtStart,
} from "./conversationMentions";

type MentionToken = { start: number; end: number; query: string };

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
	replyTo?: { memberId: string; name: string };
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
	replyTo,
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
	const [autocompleteIntent, setAutocompleteIntent] =
		useState<RecipientIntent>("mentionIds");
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
	const { refs, floatingStyles, elements, update } = useFloating({
		open: pickerOpen,
		placement: "bottom-start",
		strategy: "fixed",
		whileElementsMounted: autoUpdate,
		middleware: [
			offset(4),
			flip({ padding: 12 }),
			shift({ padding: 12 }),
			size({
				padding: 12,
				apply({ availableHeight, availableWidth, rects, elements }) {
					Object.assign(elements.floating.style, {
						width: `${Math.min(rects.reference.width, availableWidth)}px`,
						maxHeight: `${Math.max(0, Math.min(320, availableHeight))}px`,
					});
				},
			}),
		],
	});
	// Native top-layer placement escapes modal overflow without moving the picker
	// out of its conversation or the dialog's focus boundary.
	useLayoutEffect(() => {
		if (pickerOpen && elements.floating) {
			elements.floating.showPopover();
			update();
		}
	}, [pickerOpen, elements.floating, update]);
	const selectedIndex = Math.min(activeIndex, matches.length - 1);
	const replyMemberId = replyTo?.memberId || "";
	const replyMember = members.find((member) => member.id === replyMemberId);
	const replyRequested = selection.responseRecipientIds.includes(replyMemberId);

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
		if (
			autocompleteIntent === "responseRecipientIds" ||
			!selection.responseRecipientIds.includes(member.id)
		) {
			changeSelection(
				selectRecipient(selection, autocompleteIntent, member.id),
			);
		}
		setToken(null);
		requestAnimationFrame(() => {
			textarea.current?.focus();
			textarea.current?.setSelectionRange(cursor, cursor);
		});
	};

	const openMention = () => {
		const input = textarea.current;
		if (!input || disabled || selectionDisabled) return;
		const start = input.selectionStart;
		const end = input.selectionEnd;
		const existing = mentionAtCursor(body, start, members, selection);
		if (existing) {
			setToken(existing);
		} else {
			const prefix = body.slice(0, start);
			const separator =
				prefix && !/[\s([{<"'“‘,:;!?]$/u.test(prefix) ? " " : "";
			const nextBody = `${prefix}${separator}@${body.slice(end)}`;
			const at = start + separator.length;
			changeBody(nextBody);
			setToken({ start: at, end: at + 1, query: "" });
			requestAnimationFrame(() => input.setSelectionRange(at + 1, at + 1));
		}
		setActiveIndex(0);
		input.focus();
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
			{replyTo && (
				<fieldset
					aria-label="Reply notification mode"
					className="rounded-box border border-base-300 bg-base-200 p-3 mb-3 grid gap-2 text-sm"
					disabled={disabled || selectionDisabled}
				>
					<legend className="px-1 font-medium">
						Reply to{" "}
						{replyMember?.name || replyTo.name || "unavailable teammate"}
					</legend>
					{replyMember && (
						<p className="text-xs text-base-content/70 break-all">
							{memberIdentity(replyMember, members)}
						</p>
					)}
					<div className="flex flex-wrap gap-x-4 gap-y-2">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								name={`${id}-reply-intent`}
								className="radio radio-sm radio-primary"
								checked={!replyRequested}
								onChange={() =>
									changeSelection({
										...selection,
										responseRecipientIds: selection.responseRecipientIds.filter(
											(memberId) => memberId !== replyMemberId,
										),
									})
								}
							/>
							FYI
						</label>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								name={`${id}-reply-intent`}
								className="radio radio-sm radio-primary"
								checked={replyRequested}
								disabled={replyMember?.status !== "active"}
								onChange={() =>
									changeSelection(
										selectRecipient(
											selection,
											"responseRecipientIds",
											replyMemberId,
										),
									)
								}
							/>
							Request response
						</label>
					</div>
					<p className="text-xs text-base-content/70">
						FYI keeps the reply informational. Request response addresses this
						person directly, without another @mention.
					</p>
					{replyMember?.status !== "active" && (
						<p className="text-xs text-warning">
							This parent author is inactive or unavailable. You can save an FYI
							reply, but they will not be notified.
						</p>
					)}
				</fieldset>
			)}
			<div className="flex flex-wrap items-center justify-between gap-2 mb-2">
				<label htmlFor={`${id}-body`} className="label-text font-medium">
					{label}
				</label>
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					disabled={disabled || selectionDisabled}
					onMouseDown={(event) => event.preventDefault()}
					onClick={openMention}
					aria-controls={pickerOpen ? listId : undefined}
					aria-expanded={pickerOpen}
				>
					<span aria-hidden="true" className="text-lg">
						@
					</span>{" "}
					Mention someone
				</button>
			</div>
			<fieldset
				aria-label="Autocomplete notification mode"
				className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3 rounded-box border border-base-300 p-3 text-sm"
				disabled={disabled || selectionDisabled}
			>
				<legend className="px-1 text-xs text-base-content/70">
					For new @ selections
				</legend>
				{(
					[
						["mentionIds", "FYI"],
						["responseRecipientIds", "Ask to act / respond"],
					] as const
				).map(([intent, name]) => (
					<label
						key={intent}
						className="flex items-center gap-2 cursor-pointer"
					>
						<input
							type="radio"
							name={`${id}-autocomplete-intent`}
							className="radio radio-sm radio-primary"
							checked={autocompleteIntent === intent}
							onChange={() => setAutocompleteIntent(intent)}
						/>
						{name}
					</label>
				))}
			</fieldset>
			<div className="relative min-w-0">
				<textarea
					ref={(element) => {
						textarea.current = element;
						refs.setReference(element);
					}}
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
							event.stopPropagation();
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
					<div
						ref={refs.setFloating}
						popover="manual"
						style={floatingStyles}
						className="m-0 grid gap-1 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 text-base-content shadow-lg"
					>
						<p className="text-xs text-base-content/70">
							{autocompleteIntent === "mentionIds"
								? "Choose Mention / FYI"
								: "Ask to act / respond"}{" "}
							· use ↑ ↓ and Enter, or tap a teammate. Escape closes.
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
