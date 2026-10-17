import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
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
	const [expanded, setExpanded] = useState(false);
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
	const toggle = (
		key: "mentionIds" | "responseRecipientIds",
		memberId: string,
		checked: boolean,
	) =>
		onChange({
			...value,
			[key]: checked
				? [...value[key], memberId]
				: value[key].filter((id) => id !== memberId),
		});
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
			<button
				type="button"
				className="btn btn-ghost btn-sm w-fit"
				aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}
			>
				Mentions, response requests and references
				{value.mentionIds.length +
					value.responseRecipientIds.length +
					value.references.length >
				0
					? ` (${value.mentionIds.length + value.responseRecipientIds.length + value.references.length})`
					: ""}
			</button>
			{expanded && (
				<div className="rounded-box border border-base-300 p-3 grid gap-3">
					<p className="text-xs text-base-content/65">
						Mentions notify teammates. Select “Request response” explicitly when
						you need an answer. Ordinary comments do not start agents.
					</p>
					<label className="grid gap-1 text-sm">
						<span>Find teammate to mention</span>
						<input
							className="input input-bordered w-full"
							type="search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
					</label>
					<ul className="max-h-48 overflow-y-auto grid gap-2">
						{members
							.filter(
								(m) =>
									m.status === "active" &&
									`${m.name} ${m.email}`
										.toLowerCase()
										.includes(search.toLowerCase()),
							)
							.map((m) => (
								<li
									key={m.id}
									className="flex flex-wrap justify-between gap-2 text-sm"
								>
									<label className="flex gap-2 items-center">
										<input
											type="checkbox"
											className="checkbox checkbox-sm"
											checked={value.mentionIds.includes(m.id)}
											onChange={(event) =>
												toggle("mentionIds", m.id, event.target.checked)
											}
										/>
										<span>
											@{m.name} {m.kind === "agent" ? "(AI)" : ""}
										</span>
									</label>
									<label className="flex gap-2 items-center">
										<input
											type="checkbox"
											className="checkbox checkbox-sm"
											checked={value.responseRecipientIds.includes(m.id)}
											onChange={(event) =>
												toggle(
													"responseRecipientIds",
													m.id,
													event.target.checked,
												)
											}
										/>
										Request response from {m.name}
									</label>
								</li>
							))}
					</ul>
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
