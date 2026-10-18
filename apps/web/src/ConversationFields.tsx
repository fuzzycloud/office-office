import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import ActionIcon from "./ActionIcon";
import {
	listFiles,
	listReports,
	type Member,
	type RecordReference,
} from "./api";

export type ConversationSelection = {
	mentionIds: string[];
	responseRecipientIds: string[];
	references: RecordReference[];
};
export const emptySelection = (): ConversationSelection => ({
	mentionIds: [],
	responseRecipientIds: [],
	references: [],
});

export type RecipientIntent = "mentionIds" | "responseRecipientIds";

export function memberIdentity(member: Member, members: Member[]) {
	const duplicateName = members.some(
		(other) =>
			other.id !== member.id &&
			other.name.toLocaleLowerCase() === member.name.toLocaleLowerCase(),
	);
	const duplicateIdentity = members.some(
		(other) =>
			other.id !== member.id &&
			other.name.toLocaleLowerCase() === member.name.toLocaleLowerCase() &&
			other.email === member.email &&
			other.kind === member.kind,
	);
	const detail = member.email || (duplicateName ? member.id : member.jobTitle);
	return `${member.kind === "agent" ? "AI" : "Teammate"}${detail ? ` · ${detail}` : ""}${duplicateIdentity && member.email ? ` · ${member.id}` : ""}`;
}

export function selectRecipient(
	value: ConversationSelection,
	intent: RecipientIntent,
	memberId: string,
): ConversationSelection {
	const other = intent === "mentionIds" ? "responseRecipientIds" : "mentionIds";
	return {
		...value,
		[intent]: [...new Set([...value[intent], memberId])],
		[other]: value[other].filter((id) => id !== memberId),
	};
}

export function MemberOptions({
	members,
	allMembers,
	listId,
	activeIndex,
	onActiveIndexChange,
	onSelect,
}: {
	members: Member[];
	allMembers: Member[];
	listId: string;
	activeIndex: number;
	onActiveIndexChange: (index: number) => void;
	onSelect: (member: Member) => void;
}) {
	const activeOption = useRef<HTMLButtonElement>(null);
	const activeMemberId = members[activeIndex]?.id;
	useEffect(() => {
		const option = activeOption.current;
		const list = option?.parentElement;
		if (!activeMemberId || !option || !list) return;
		// Scroll only the options, never the containing modal/page. A top-layer
		// popover remains a DOM descendant of those scrolling containers.
		const optionBox = option.getBoundingClientRect();
		const listBox = list.getBoundingClientRect();
		if (optionBox.top < listBox.top)
			list.scrollTop -= listBox.top - optionBox.top;
		else if (optionBox.bottom > listBox.bottom)
			list.scrollTop += optionBox.bottom - listBox.bottom;
	}, [activeMemberId]);
	return (
		<>
			<div
				id={listId}
				role="listbox"
				tabIndex={-1}
				aria-label="Active teammates"
				className="max-h-52 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1"
			>
				{members.map((member, index) => (
					<button
						type="button"
						tabIndex={-1}
						key={member.id}
						ref={index === activeIndex ? activeOption : undefined}
						id={`${listId}-${index}`}
						role="option"
						aria-selected={index === activeIndex}
						className={`block w-full text-left rounded px-3 py-2 cursor-pointer text-sm ${index === activeIndex ? "bg-base-200" : "hover:bg-base-200"}`}
						onMouseEnter={() => onActiveIndexChange(index)}
						onPointerDown={(event) => event.preventDefault()}
						onClick={() => onSelect(member)}
					>
						<span className="block font-medium break-words">{member.name}</span>
						<span className="block text-xs text-base-content/70 break-all">
							{memberIdentity(member, allMembers)}
						</span>
					</button>
				))}
			</div>
			{!members.length && (
				<p role="status" className="text-sm text-base-content/70 p-2">
					No active teammates match your search.
				</p>
			)}
		</>
	);
}

export function matchingMembers(members: Member[], query: string) {
	const search = query.trim().toLocaleLowerCase();
	return members.filter(
		(member) =>
			member.status === "active" &&
			`${member.name} ${member.email} ${member.id} ${member.kind === "agent" ? "AI" : ""}`
				.toLocaleLowerCase()
				.includes(search),
	);
}
export function sourceHref(kind: string, id: string, revision = 0) {
	const route =
		kind === "report"
			? "reports"
			: kind === "file"
				? "files"
				: kind === "customer"
					? "customers"
					: kind === "member"
						? "team"
						: "projects";
	return `/${route}?${new URLSearchParams({ sourceKind: kind, sourceId: id, ...(revision ? { revision: String(revision) } : {}) })}`;
}
export function ReferenceLinks({
	references,
}: {
	references: RecordReference[];
}) {
	return (
		<ul className="flex flex-wrap gap-2 mt-2">
			{references.map((ref) => (
				<li key={`${ref.kind}:${ref.id}:${ref.revision}`}>
					<a
						className="link text-sm"
						href={sourceHref(ref.kind, ref.id, ref.revision)}
					>
						{ref.kind} {ref.id} · revision {ref.revision}
					</a>
				</li>
			))}
		</ul>
	);
}
export default function ConversationFields({
	members,
	value,
	onChange,
	disabled = false,
	projectId,
}: {
	members: Member[];
	value: ConversationSelection;
	onChange: (value: ConversationSelection) => void;
	disabled?: boolean;
	projectId: string;
}) {
	const [search, setSearch] = useState("");
	const id = useId();
	const pickerId = `${id}-members`;
	const searchRef = useRef<HTMLInputElement>(null);
	const pickerTriggers = useRef<
		Partial<Record<RecipientIntent, HTMLButtonElement | null>>
	>({});
	const [intent, setIntent] = useState<RecipientIntent | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		if (intent) searchRef.current?.focus();
	}, [intent]);
	const reports = useQuery({
		queryKey: ["conversation-reports", projectId],
		queryFn: () =>
			listReports({ query: "", status: "", pageSize: 100, offset: 0 }),
		enabled: expanded,
		retry: false,
	});
	const files = useQuery({
		queryKey: ["files", "conversation-references"],
		queryFn: () => listFiles(""),
		enabled: expanded,
		retry: false,
	});
	const matches = matchingMembers(members, search);
	const closePicker = () => {
		if (intent) pickerTriggers.current[intent]?.focus();
		setIntent(null);
	};
	const chooseMember = (member: Member) => {
		if (!intent || disabled) return;
		onChange(selectRecipient(value, intent, member.id));
		setSearch("");
		setActiveIndex(0);
		closePicker();
	};
	const options = [
		...(reports.data?.reports || [])
			.filter((r) => !r.projectId || r.projectId === projectId)
			.map((r) => ({
				kind: "report",
				id: r.id,
				revision: r.revision,
				title: r.title,
			})),
		...(files.data?.files || [])
			.filter((f) =>
				f.module === "projects"
					? !f.recordId || f.recordId === projectId
					: f.module === "reports" &&
						(!f.recordId ||
							reports.data?.reports.some(
								(r) =>
									r.id === f.recordId &&
									(!r.projectId || r.projectId === projectId),
							)),
			)
			.map((f) => ({
				kind: "file",
				id: f.id,
				revision: f.revision,
				title: f.name,
			})),
	];
	return (
		<fieldset disabled={disabled} className="grid gap-3 mt-3 min-w-0">
			<legend className="sr-only">
				Conversation recipients and references
			</legend>
			<p className="text-xs text-base-content/70">
				Mention / FYI notifies teammates. Request a response explicitly when you
				need an answer or action. Connected workers may pick up eligible
				requests on their next poll; FYI notices do not request execution.
			</p>
			{(
				[
					["mentionIds", "Mention / FYI", "Add Mention / FYI"],
					["responseRecipientIds", "Request response", "Add response request"],
				] as const
			).map(([key, label, buttonLabel]) => (
				<section key={key} aria-label={label} className="grid gap-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h4 className="text-sm font-medium">{label}</h4>
						<button
							ref={(button) => {
								pickerTriggers.current[key] = button;
							}}
							type="button"
							className="btn btn-ghost btn-sm"
							aria-expanded={intent === key}
							aria-controls={`${pickerId}-panel`}
							onClick={() => {
								setIntent(intent === key ? null : key);
								setSearch("");
								setActiveIndex(0);
							}}
						>
							<ActionIcon name="plus" size={16} />
							{buttonLabel}
						</button>
					</div>
					{value[key].length > 0 ? (
						<ul
							className="flex flex-wrap gap-2"
							aria-label={`${label} recipients`}
						>
							{value[key].map((memberId) => {
								const member = members.find(
									(candidate) => candidate.id === memberId,
								);
								const name =
									member?.name || `Unavailable teammate (${memberId})`;
								const detail = member
									? memberIdentity(member, members)
									: memberId;
								return (
									<li
										key={memberId}
										className="flex max-w-full items-center gap-1 rounded-box border border-base-300 bg-base-200 px-2 py-1 text-sm"
									>
										<span className="min-w-0 break-words" title={detail}>
											{name}
											{member?.kind === "agent" ? " (AI)" : ""}
											{members.some(
												(other) =>
													other.id !== memberId &&
													other.name.toLocaleLowerCase() ===
														member?.name.toLocaleLowerCase(),
											) && (
												<span className="block text-xs text-base-content/70 break-all">
													{detail}
												</span>
											)}
											{member && member.status !== "active" && (
												<span className="block text-xs text-warning">
													Inactive · remove before posting
												</span>
											)}
										</span>
										<button
											type="button"
											className="btn btn-ghost btn-sm btn-square shrink-0"
											aria-label={`Remove ${name} (${detail}) from ${label}`}
											onClick={() =>
												onChange({
													...value,
													[key]: value[key].filter((id) => id !== memberId),
												})
											}
										>
											<ActionIcon name="close" size={16} />
										</button>
									</li>
								);
							})}
						</ul>
					) : (
						<p className="text-xs text-base-content/60">
							No recipients selected.
						</p>
					)}
				</section>
			))}
			{intent && (
				<div
					id={`${pickerId}-panel`}
					className="rounded-box border border-base-300 p-3 grid gap-2"
				>
					<label htmlFor={`${pickerId}-search`} className="text-sm font-medium">
						{intent === "mentionIds"
							? "Find teammate to mention"
							: "Find teammate to request a response"}
					</label>
					<input
						ref={searchRef}
						id={`${pickerId}-search`}
						className="input input-bordered w-full"
						type="search"
						role="combobox"
						aria-autocomplete="list"
						aria-expanded="true"
						aria-controls={pickerId}
						aria-activedescendant={
							matches.length
								? `${pickerId}-${Math.min(activeIndex, matches.length - 1)}`
								: undefined
						}
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setActiveIndex(0);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								closePicker();
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
							if (event.key === "Enter") {
								event.preventDefault();
								const member =
									matches[Math.min(activeIndex, matches.length - 1)];
								if (member) chooseMember(member);
							}
						}}
					/>
					<MemberOptions
						members={matches}
						allMembers={members}
						listId={pickerId}
						activeIndex={Math.min(activeIndex, matches.length - 1)}
						onActiveIndexChange={setActiveIndex}
						onSelect={chooseMember}
					/>
					<button
						type="button"
						className="btn btn-ghost btn-sm w-fit"
						onClick={closePicker}
					>
						Done choosing recipients
					</button>
				</div>
			)}
			<button
				type="button"
				className="btn btn-ghost btn-sm w-fit"
				aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}
			>
				Attach references
				{value.references.length ? ` (${value.references.length})` : ""}
			</button>
			{expanded && (
				<div className="rounded-box border border-base-300 p-3 grid gap-3">
					<div className="grid gap-1 text-sm">
						<label htmlFor={id}>Attach exact report or file revision</label>
						<select
							id={id}
							className="select select-bordered w-full"
							value=""
							onChange={(event) => {
								const item = options.find(
									(item) => `${item.kind}:${item.id}` === event.target.value,
								);
								if (
									item &&
									!value.references.some(
										(ref) =>
											ref.kind === item.kind &&
											ref.id === item.id &&
											ref.revision === item.revision,
									)
								)
									onChange({
										...value,
										references: [
											...value.references,
											{ kind: item.kind, id: item.id, revision: item.revision },
										],
									});
							}}
						>
							<option value="">Choose reference</option>
							{options.map((item) => (
								<option
									key={`${item.kind}:${item.id}`}
									value={`${item.kind}:${item.id}`}
								>
									{item.kind}: {item.title} (revision {item.revision})
								</option>
							))}
						</select>
					</div>
					{(reports.isError || files.isError) && (
						<p role="alert" className="text-error text-sm">
							Some references could not load.{" "}
							<button
								className="link"
								type="button"
								onClick={() => {
									void reports.refetch();
									void files.refetch();
								}}
							>
								Retry
							</button>
						</p>
					)}
					<ul className="grid gap-1">
						{value.references.map((ref) => (
							<li
								key={`${ref.kind}:${ref.id}`}
								className="flex gap-2 text-sm items-center"
							>
								<span className="break-all">
									{options.find(
										(item) => item.kind === ref.kind && item.id === ref.id,
									)?.title || ref.id}{" "}
									· revision {ref.revision}
								</span>
								<button
									className="btn btn-ghost btn-xs"
									type="button"
									aria-label={`Remove reference ${ref.id}`}
									onClick={() =>
										onChange({
											...value,
											references: value.references.filter((r) => r !== ref),
										})
									}
								>
									Remove
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</fieldset>
	);
}
