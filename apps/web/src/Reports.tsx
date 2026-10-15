import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getReport, listReports, saveReport, type Report } from "./api";
import type { Member, Project, Task } from "./api";

type ReportDraft = Omit<
	Report,
	"$typeName" | "createdAt" | "updatedAt" | "revision" | "sources"
> & {
	createdAt: bigint;
	updatedAt: bigint;
	revision: number;
	sources: Array<{ title: string; url: string }>;
};
type Props = {
	canEdit: boolean;
	currentUser: Member;
	members: Member[];
	projects: Project[];
	tasks: Task[];
};
const PAGE_SIZE = 20;
const blankReport = (authorId: string): ReportDraft => ({
	id: "",
	title: "",
	summary: "",
	body: "",
	kind: "research",
	status: "draft",
	topic: "",
	period: "",
	projectId: "",
	taskId: "",
	authorId,
	authorName: "",
	createdAt: 0n,
	updatedAt: 0n,
	updatedBy: "",
	revision: 0,
	sources: [],
});
const timestamp = (value: bigint) => {
	if (!value) return "Not saved yet";
	const date = new Date(Number(value) * 1000);
	return Number.isNaN(date.getTime())
		? "Time unavailable"
		: new Intl.DateTimeFormat(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(date);
};
const safeUrl = (raw: string) => {
	try {
		const url = new URL(raw);
		return (url.protocol === "http:" || url.protocol === "https:") &&
			!url.username &&
			!url.password
			? url.href
			: null;
	} catch {
		return null;
	}
};

function inline(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const pattern = /\[([^\]]+)\]\(([^\s)]+)\)/g;
	let cursor = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > cursor) nodes.push(text.slice(cursor, index));
		const href = safeUrl(match[2]);
		nodes.push(
			href ? (
				<a key={`link-${index}`} href={href} target="_blank" rel="noreferrer">
					{match[1]}
				</a>
			) : (
				match[0]
			),
		);
		cursor = index + match[0].length;
	}
	if (cursor < text.length) nodes.push(text.slice(cursor));
	return nodes;
}

function ReportBody({ body }: { body: string }) {
	const blocks: ReactNode[] = [];
	const lines = body.split(/\r?\n/);
	let paragraph: string[] = [];
	let bullets: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length) {
			blocks.push(
				<p key={`p-${blocks.length}`}>{inline(paragraph.join(" "))}</p>,
			);
			paragraph = [];
		}
	};
	const flushBullets = () => {
		if (bullets.length) {
			blocks.push(
				<ul key={`ul-${blocks.length}`}>
					{bullets.map((item, index) => (
						<li key={index}>{inline(item)}</li>
					))}
				</ul>,
			);
			bullets = [];
		}
	};
	for (const line of lines) {
		const heading = /^(#{1,3})\s+(.+)$/.exec(line);
		const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
		if (heading) {
			flushParagraph();
			flushBullets();
			const Tag = `h${heading[1].length + 1}` as "h2" | "h3" | "h4";
			blocks.push(<Tag key={`h-${blocks.length}`}>{inline(heading[2])}</Tag>);
		} else if (bullet) {
			flushParagraph();
			bullets.push(bullet[1]);
		} else if (!line.trim()) {
			flushParagraph();
			flushBullets();
		} else {
			flushBullets();
			paragraph.push(line);
		}
	}
	flushParagraph();
	flushBullets();
	return (
		<div className="report-prose">{blocks.length ? blocks : <p>{body}</p>}</div>
	);
}

export default function Reports({
	canEdit,
	currentUser,
	members,
	projects,
	tasks,
}: Props) {
	const queryClient = useQueryClient();
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState("");
	const [projectId, setProjectId] = useState("");
	const [offset, setOffset] = useState(0);
	const [selectedId, setSelectedId] = useState("");
	const [draft, setDraft] = useState<ReportDraft | null>(null);
	const [editing, setEditing] = useState(false);
	const [saveError, setSaveError] = useState("");
	const [sourceTitle, setSourceTitle] = useState("");
	const [sourceUrl, setSourceUrl] = useState("");
	const listQuery = useQuery({
		queryKey: ["reports", search, status, projectId, offset],
		queryFn: () =>
			listReports({
				query: search.trim(),
				status,
				projectId,
				pageSize: PAGE_SIZE,
				offset,
			}),
	});
	const detailQuery = useQuery({
		queryKey: ["report", selectedId],
		queryFn: () => getReport(selectedId),
		enabled: !!selectedId && !editing,
	});
	const saveMutation = useMutation({
		mutationFn: ({
			report,
			expectedRevision,
		}: {
			report: ReportDraft;
			expectedRevision: number;
		}) => saveReport(report, expectedRevision),
		onSuccess: async (saved) => {
			await queryClient.invalidateQueries({ queryKey: ["reports"] });
			await queryClient.invalidateQueries({ queryKey: ["report", saved.id] });
			queryClient.setQueryData(["report", saved.id], { report: saved });
			await queryClient.invalidateQueries({ queryKey: ["workspace"] });
			setSelectedId(saved.id);
			setDraft(null);
			setEditing(false);
			setSaveError("");
		},
		onError: (error) => {
			setSaveError(
				`${error.message} Your draft is still here. Reload the report before trying again.`,
			);
		},
	});
	const reports = listQuery.data?.reports ?? [];
	const current = detailQuery.data?.report ?? null;
	const rangeLabel = listQuery.data
		? listQuery.data.totalCount === 0
			? "0 reports"
			: `${offset + 1}–${Math.min(offset + reports.length, listQuery.data.totalCount)} of ${listQuery.data.totalCount}`
		: "";
	const hasFilters = Boolean(search || status || projectId);
	const selectedName = useMemo(() => {
		const projectName = projects.find(
			(project) => project.id === current?.projectId,
		)?.name;
		const taskName = tasks.find((task) => task.id === current?.taskId)?.title;
		return { projectName, taskName };
	}, [current?.projectId, current?.taskId, projects, tasks]);
	function beginNew(seed?: Report) {
		setSourceTitle("");
		setSourceUrl("");
		setSelectedId("");
		setSaveError("");
		setDraft({
			...blankReport(currentUser.id),
			topic: seed?.topic ?? "",
			period: seed?.period ?? "",
			title: seed?.title ?? "",
			summary: seed?.summary ?? "",
			kind: seed?.kind ?? "research",
		});
		setEditing(true);
	}
	function beginEdit(report: Report) {
		setSourceTitle("");
		setSourceUrl("");
		setSaveError("");
		setDraft({
			...report,
			sources: report.sources.map((source) => ({ ...source })),
		});
		setEditing(true);
	}
	function update<K extends keyof ReportDraft>(key: K, value: ReportDraft[K]) {
		setDraft((valueNow) =>
			valueNow ? { ...valueNow, [key]: value } : valueNow,
		);
	}
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!draft) return;
		setSaveError("");
		saveMutation.mutate({ report: draft, expectedRevision: draft.revision });
	}
	async function reloadDraft() {
		if (!draft?.id) return;
		const id = draft.id;
		try {
			await queryClient.fetchQuery({
				queryKey: ["report", id],
				queryFn: () => getReport(id),
				staleTime: 0,
			});
			setDraft(null);
			setEditing(false);
			setSelectedId(id);
			setSaveError("");
		} catch (error) {
			setSaveError(
				`Could not reload the report: ${error instanceof Error ? error.message : "Unknown error"}. Your draft is still here.`,
			);
		}
	}
	function addSource() {
		const url = safeUrl(sourceUrl.trim());
		if (!url || !sourceTitle.trim() || !draft) return;
		update("sources", [...draft.sources, { title: sourceTitle.trim(), url }]);
		setSourceTitle("");
		setSourceUrl("");
	}
	return (
		<section className="reports-desk">
			<div className="reports-heading">
				<div>
					<p className="reports-intro">Research library</p>
					<h2>Reports</h2>
					<p>
						Long-form research and competitor reviews, kept with their sources.
					</p>
				</div>
				{canEdit && (
					<button
						className="btn btn-primary"
						disabled={saveMutation.isPending}
						onClick={() => beginNew()}
					>
						＋ New report
					</button>
				)}
			</div>
			<div className="reports-layout">
				<aside className="reports-index" aria-label="Report library">
					<div className="reports-controls">
						<label className="form-control">
							<span className="label-text mb-1">Search reports</span>
							<input
								className="input input-bordered input-sm"
								value={search}
								onChange={(event) => {
									setSearch(event.target.value);
									setOffset(0);
								}}
								placeholder="Title, topic, period"
							/>
						</label>
						<div className="form-control">
							<label
								className="label-text mb-1"
								htmlFor="reports-status-filter"
							>
								Status
							</label>
							<select
								id="reports-status-filter"
								className="select select-bordered select-sm"
								value={status}
								onChange={(event) => {
									setStatus(event.target.value);
									setOffset(0);
								}}
							>
								<option value="">All reports</option>
								<option value="draft">Draft</option>
								<option value="published">Published</option>
							</select>
						</div>
						<div className="form-control">
							<label
								className="label-text mb-1"
								htmlFor="reports-project-filter"
							>
								Filter by project
							</label>
							<select
								id="reports-project-filter"
								className="select select-bordered select-sm"
								value={projectId}
								onChange={(event) => {
									setProjectId(event.target.value);
									setOffset(0);
								}}
							>
								<option value="">All projects</option>
								{projects.map((project) => (
									<option key={project.id} value={project.id}>
										{project.name}
									</option>
								))}
							</select>
						</div>
					</div>
					{listQuery.isError && (
						<p role="alert" className="report-error">
							{listQuery.error.message}
						</p>
					)}
					{listQuery.isPending ? (
						<p className="report-empty">Loading reports…</p>
					) : reports.length ? (
						<div className="report-list">
							{reports.map((report) => (
								<button
									key={report.id}
									className={`report-list-item ${selectedId === report.id && !editing ? "is-selected" : ""}`}
									disabled={saveMutation.isPending}
									onClick={() => {
										setSelectedId(report.id);
										setDraft(null);
										setEditing(false);
										setSaveError("");
									}}
								>
									<span className="report-list-top">
										<span className="report-kind">
											{report.kind === "competitor_review"
												? "Competitor review"
												: "Research"}
										</span>
										<span
											className={`badge badge-sm ${report.status === "published" ? "badge-success badge-outline" : "badge-ghost"}`}
										>
											{report.status}
										</span>
									</span>
									<strong>
										{report.title || report.topic || "Untitled report"}
									</strong>
									<span>
										{[report.topic, report.period]
											.filter(Boolean)
											.join(" · ") || "Topic and period not set"}
									</span>
									<small>Updated {timestamp(report.updatedAt)}</small>
								</button>
							))}
						</div>
					) : (
						<div className="report-empty">
							<strong>
								{hasFilters
									? "No reports match these filters"
									: "No reports yet"}
							</strong>
							<p>
								{hasFilters
									? "Try a different search or status."
									: "Start a report to keep useful research and its sources in one place."}
							</p>
							{canEdit && !hasFilters && (
								<button
									className="btn btn-sm btn-primary"
									disabled={saveMutation.isPending}
									onClick={() => beginNew()}
								>
									Write the first report
								</button>
							)}
						</div>
					)}
					<div className="report-pagination">
						<button
							className="btn btn-ghost btn-sm"
							disabled={offset === 0 || listQuery.isFetching}
							onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
						>
							Previous
						</button>
						<span>{rangeLabel}</span>
						<button
							className="btn btn-ghost btn-sm"
							disabled={!listQuery.data?.nextOffset || listQuery.isFetching}
							onClick={() => setOffset(listQuery.data?.nextOffset ?? offset)}
						>
							Next
						</button>
					</div>
				</aside>
				<article className="report-reader">
					{editing && draft ? (
						<form
							onSubmit={submit}
							className="report-editor"
							aria-label="Report editor"
						>
							<div className="report-editor-head">
								<div>
									<p className="reports-intro">
										{draft.id ? "Edit report" : "New edition"}
									</p>
									<h3>
										{draft.id
											? draft.title || "Untitled report"
											: "A new report"}
									</h3>
								</div>
								<button
									type="button"
									className="btn btn-ghost btn-sm"
									disabled={saveMutation.isPending}
									onClick={() => {
										setDraft(null);
										setEditing(false);
									}}
								>
									Close
								</button>
							</div>
							<fieldset
								className="report-editor-fields"
								disabled={saveMutation.isPending}
							>
								{saveError && (
									<div role="alert" className="alert alert-error">
										<div>
											<p>{saveError}</p>
											{draft.id && (
												<button
													type="button"
													className="btn btn-error btn-outline btn-sm mt-2"
													onClick={() => void reloadDraft()}
												>
													Reload report and discard draft
												</button>
											)}
										</div>
									</div>
								)}
								<div className="report-form-grid">
									<label className="form-control">
										<span className="label-text">Report title</span>
										<input
											className="input input-bordered"
											required
											value={draft.title}
											onChange={(event) => update("title", event.target.value)}
										/>
									</label>
									<label className="form-control">
										<span className="label-text">Topic</span>
										<input
											className="input input-bordered"
											value={draft.topic}
											onChange={(event) => update("topic", event.target.value)}
										/>
									</label>
									<label className="form-control">
										<span className="label-text">Reporting period</span>
										<input
											className="input input-bordered"
											value={draft.period}
											onChange={(event) => update("period", event.target.value)}
											placeholder="e.g. Q2 2026"
										/>
									</label>
									<div className="form-control">
										<label className="label-text" htmlFor="report-kind">
											Report type
										</label>
										<select
											id="report-kind"
											className="select select-bordered"
											value={draft.kind}
											onChange={(event) => update("kind", event.target.value)}
										>
											<option value="research">Research</option>
											<option value="competitor_review">
												Competitor review
											</option>
										</select>
									</div>
									<div className="form-control">
										<label className="label-text" htmlFor="report-status">
											Status
										</label>
										<select
											id="report-status"
											className="select select-bordered"
											value={draft.status}
											onChange={(event) => update("status", event.target.value)}
										>
											<option value="draft">Draft</option>
											<option value="published">Published</option>
										</select>
									</div>
									<div className="form-control">
										<label className="label-text" htmlFor="report-project">
											Project
										</label>
										<select
											id="report-project"
											className="select select-bordered"
											value={draft.projectId}
											onChange={(event) => {
												update("projectId", event.target.value);
												update("taskId", "");
											}}
										>
											<option value="">No project</option>
											{projects.map((project) => (
												<option key={project.id} value={project.id}>
													{project.name}
												</option>
											))}
										</select>
									</div>
									<div className="form-control">
										<label className="label-text" htmlFor="report-task">
											Task
										</label>
										<select
											id="report-task"
											className="select select-bordered"
											value={draft.taskId}
											onChange={(event) => {
												const task = tasks.find(
													(item) => item.id === event.target.value,
												);
												if (task) update("projectId", task.projectId);
												update("taskId", event.target.value);
											}}
										>
											<option value="">No task</option>
											{tasks
												.filter(
													(task) =>
														!draft.projectId ||
														task.projectId === draft.projectId,
												)
												.map((task) => (
													<option key={task.id} value={task.id}>
														{task.title}
													</option>
												))}
										</select>
									</div>
									<div className="form-control">
										<label className="label-text" htmlFor="report-summary">
											Short summary
										</label>
										<textarea
											id="report-summary"
											className="textarea textarea-bordered min-h-20"
											value={draft.summary}
											onChange={(event) =>
												update("summary", event.target.value)
											}
										/>
									</div>
								</div>
								<div className="form-control">
									<label className="label-text" htmlFor="report-content">
										Report content
									</label>
									<textarea
										id="report-content"
										className="textarea textarea-bordered report-body-input"
										value={draft.body}
										onChange={(event) => update("body", event.target.value)}
										placeholder="Write in plain text or Markdown. Use headings with #, ## or ### and bullets with - ."
									/>
								</div>
								<div className="report-sources-editor">
									<h4>Sources</h4>
									{draft.sources.map((source, index) => (
										<div
											className="report-source-edit"
											key={`${source.url}-${index}`}
										>
											<a
												href={safeUrl(source.url) ?? undefined}
												target="_blank"
												rel="noreferrer"
											>
												{source.title}
											</a>
											<button
												type="button"
												className="btn btn-ghost btn-xs"
												aria-label={`Remove ${source.title}`}
												onClick={() =>
													update(
														"sources",
														draft.sources.filter((_, i) => i !== index),
													)
												}
											>
												Remove
											</button>
										</div>
									))}
									<div className="report-source-add">
										<label
											className="form-control"
											htmlFor="report-source-title"
										>
											<span className="label-text">Source title</span>
											<input
												id="report-source-title"
												className="input input-bordered input-sm"
												value={sourceTitle}
												onChange={(event) => setSourceTitle(event.target.value)}
											/>
										</label>
										<label className="form-control" htmlFor="report-source-url">
											<span className="label-text">Source URL</span>
											<input
												id="report-source-url"
												className="input input-bordered input-sm"
												type="url"
												value={sourceUrl}
												onChange={(event) => setSourceUrl(event.target.value)}
											/>
										</label>
										<button
											type="button"
											className="btn btn-outline btn-sm self-end"
											disabled={!safeUrl(sourceUrl) || !sourceTitle.trim()}
											onClick={addSource}
										>
											Add source
										</button>
									</div>
								</div>
								<div className="report-form-actions">
									<span>Author: {currentUser.name}</span>
									<button
										type="submit"
										className="btn btn-primary"
										disabled={saveMutation.isPending}
									>
										{saveMutation.isPending ? "Saving…" : "Save report"}
									</button>
								</div>
							</fieldset>
						</form>
					) : detailQuery.isPending && selectedId ? (
						<div className="report-empty">Loading report…</div>
					) : current ? (
						<div className="report-reading">
							<div className="report-reading-actions">
								{canEdit && (
									<>
										<button
											className="btn btn-outline btn-sm"
											disabled={saveMutation.isPending}
											onClick={() => beginEdit(current)}
										>
											Edit report
										</button>
										<button
											className="btn btn-primary btn-sm"
											disabled={saveMutation.isPending}
											onClick={() => beginNew(current)}
										>
											New edition
										</button>
									</>
								)}
							</div>
							<div className="report-reading-head">
								<div className="report-list-top">
									<span className="report-kind">
										{current.kind === "competitor_review"
											? "Competitor review"
											: "Research"}
									</span>
									<span
										className={`badge ${current.status === "published" ? "badge-success badge-outline" : "badge-ghost"}`}
									>
										{current.status}
									</span>
								</div>
								<h3>{current.title || "Untitled report"}</h3>
								<p className="report-deck">{current.summary}</p>
								<div className="report-meta">
									<span>
										<small>Topic</small>
										<strong>{current.topic || "Not set"}</strong>
									</span>
									<span>
										<small>Period</small>
										<strong>{current.period || "Not set"}</strong>
									</span>
									{selectedName.projectName && (
										<span>
											<small>Project</small>
											<strong>{selectedName.projectName}</strong>
										</span>
									)}
									{selectedName.taskName && (
										<span>
											<small>Task</small>
											<strong>{selectedName.taskName}</strong>
										</span>
									)}
								</div>
								<p className="report-byline">
									By{" "}
									{current.authorName ||
										members.find((member) => member.id === current.authorId)
											?.name ||
										"Unknown author"}{" "}
									· Updated by{" "}
									{members.find((member) => member.id === current.updatedBy)
										?.name ||
										current.updatedBy ||
										"Unknown editor"}{" "}
									· {timestamp(current.updatedAt)} · Revision {current.revision}
								</p>
							</div>
							<ReportBody body={current.body} />
							{current.sources.length > 0 && (
								<section className="report-sources">
									<h4>Sources</h4>
									<ol>
										{current.sources.map((source, index) => {
											const href = safeUrl(source.url);
											return (
												<li key={`${source.url}-${index}`}>
													{href ? (
														<a href={href} target="_blank" rel="noreferrer">
															{source.title || source.url}
														</a>
													) : (
														<span>
															{source.title}: {source.url}
														</span>
													)}
												</li>
											);
										})}
									</ol>
								</section>
							)}
						</div>
					) : (
						<div className="report-empty report-reader-empty">
							<span aria-hidden="true">⌕</span>
							<h3>Choose a report to read</h3>
							<p>
								Select a report from the library, or start a new one to record
								research and citations.
							</p>
						</div>
					)}
					{detailQuery.isError && selectedId && (
						<p role="alert" className="report-error">
							{detailQuery.error.message}
						</p>
					)}
				</article>
			</div>
		</section>
	);
}
