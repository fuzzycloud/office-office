import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import * as v from "valibot";
import {
	getBoard,
	saveBoard,
	type Board,
	type Entry,
	type Price,
	type Target,
} from "./api";

type Section =
	| "today"
	| "targets"
	| "strategy"
	| "projects"
	| "pricing"
	| "connections";
const nav: { id: Section; label: string; icon: string }[] = [
	{ id: "today", label: "Today", icon: "◷" },
	{ id: "targets", label: "Targets", icon: "◎" },
	{ id: "strategy", label: "Strategy", icon: "↗" },
	{ id: "projects", label: "Projects", icon: "▤" },
	{ id: "pricing", label: "Pricing", icon: "⌁" },
	{ id: "connections", label: "Connections", icon: "⇄" },
];

const titles: Record<
	Section,
	{ eyebrow: string; title: string; description: string }
> = {
	today: {
		eyebrow: "THE DAILY BOARD",
		title: "Good work starts here.",
		description: "A shared view of what matters across the office today.",
	},
	targets: {
		eyebrow: "DIRECTION",
		title: "Targets",
		description: "The outcomes you are working toward, and where they stand.",
	},
	strategy: {
		eyebrow: "THE LONG VIEW",
		title: "Strategy",
		description: "Keep the thinking behind the work close to the work itself.",
	},
	projects: {
		eyebrow: "WORK IN MOTION",
		title: "Projects",
		description: "A clear home for active, paused, and completed work.",
	},
	pricing: {
		eyebrow: "COMMERCIAL NOTES",
		title: "Pricing history",
		description:
			"Record changes in price with the date and project they belong to.",
	},
	connections: {
		eyebrow: "CONNECTED WORK",
		title: "Connections",
		description: "Read-only context from the tools your team already uses.",
	},
};

function id() {
	return crypto.randomUUID();
}
function dateLabel(value?: string) {
	if (typeof value !== "string" || !value.trim()) return "Date unknown";
	const date = new Date(value + (value.length === 10 ? "T12:00:00" : ""));
	return Number.isNaN(date.getTime())
		? "Date unknown"
		: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export default function App() {
	const [section, setSection] = useState<Section>("today");
	const [humanToken, setHumanToken] = useState(
		() =>
			sessionStorage.getItem("office-office-human-token") ??
			sessionStorage.getItem("office-office-token") ??
			"",
	);
	const [agentToken, setAgentToken] = useState(
		() => sessionStorage.getItem("office-office-agent-token") ?? "",
	);
	const [identity, setIdentity] = useState<"human" | "agent">(() =>
		sessionStorage.getItem("office-office-identity") === "agent"
			? "agent"
			: "human",
	);
	const [showToken, setShowToken] = useState(false);
	const queryClient = useQueryClient();
	const boardQuery = useQuery({ queryKey: ["board"], queryFn: getBoard });
	const saveMutation = useMutation({
		mutationFn: saveBoard,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
	});
	const board = boardQuery.data;
	const heading = titles[section];

	async function persist(next: Board): Promise<boolean> {
		try {
			await saveMutation.mutateAsync(next);
			return true;
		} catch {
			return false;
		}
	}
	function rememberToken(event: FormEvent) {
		event.preventDefault();
		if (humanToken.trim())
			sessionStorage.setItem("office-office-human-token", humanToken.trim());
		else sessionStorage.removeItem("office-office-human-token");
		if (agentToken.trim())
			sessionStorage.setItem("office-office-agent-token", agentToken.trim());
		else sessionStorage.removeItem("office-office-agent-token");
		sessionStorage.setItem("office-office-identity", identity);
		setShowToken(false);
		queryClient.invalidateQueries({ queryKey: ["board"] });
	}

	return (
		<div className="app-shell">
			<aside className="sidebar" aria-label="Main navigation">
				<a
					className="brand"
					href="#today"
					onClick={(e) => {
						e.preventDefault();
						setSection("today");
					}}
				>
					<span className="brand-mark" aria-hidden="true">
						o<span>o</span>
					</span>
					<span>
						office office<small>THE SHARED BOARD</small>
					</span>
				</a>
				<div className="workspace-label">
					WORKSPACE <span>↗</span>
				</div>
				<nav>
					{nav.map((item) => (
						<button
							key={item.id}
							className={`nav-item ${section === item.id ? "selected" : ""}`}
							onClick={() => setSection(item.id)}
							aria-current={section === item.id ? "page" : undefined}
						>
							<span className="nav-icon">{item.icon}</span>
							{item.label}
							{item.id === "projects" && board?.projects.length ? (
								<span className="nav-count">
									{
										board.projects.filter(
											(p) => p.status === "active" || !p.status,
										).length
									}
								</span>
							) : null}
						</button>
					))}
				</nav>
				<div className="sidebar-bottom">
					<div className="presence">
						<span
							className={`presence-dot ${boardQuery.isError ? "offline" : ""}`}
						/>
						<span>
							<b>
								{boardQuery.isSuccess
									? "Board connected"
									: boardQuery.isError
										? "Board offline"
										: "Connecting to board"}
							</b>
							<small>
								{boardQuery.isError
									? "Check access or connection"
									: "Changes save to your office"}
							</small>
						</span>
					</div>
					<button className="account-button" onClick={() => setShowToken(true)}>
						<span className="avatar">{identity === "agent" ? "A" : "Y"}</span>
						<span>
							<b>{identity === "agent" ? "Agent access" : "Your workspace"}</b>
							<small>
								{(identity === "agent" ? agentToken : humanToken)
									? "Credential set"
									: "Set credential"}
							</small>
						</span>
						<span className="dots">···</span>
					</button>
				</div>
			</aside>

			<main className="main-panel">
				<header className="topbar">
					<div className="breadcrumb">
						Office <span>/</span> {nav.find((x) => x.id === section)?.label}
					</div>
					<div className="top-actions">
						<span className="today-date">
							{new Intl.DateTimeFormat(undefined, {
								weekday: "short",
								month: "short",
								day: "numeric",
							}).format(new Date())}
						</span>
						<button className="view-mode" onClick={() => setShowToken(true)}>
							{identity === "agent" ? "Agent access" : "Human access"}
						</button>
						<button
							className="icon-button"
							title="Access settings"
							aria-label="Access settings"
							onClick={() => setShowToken(true)}
						>
							⚙
						</button>
						<div
							className="avatar small-avatar"
							aria-label={
								identity === "agent" ? "Agent access" : "Your workspace"
							}
						>
							{identity === "agent" ? "A" : "Y"}
						</div>
					</div>
				</header>
				<div className="content-wrap">
					<div className="page-heading">
						<div>
							<div className="eyebrow">{heading.eyebrow}</div>
							<h1>{heading.title}</h1>
							<p>{heading.description}</p>
						</div>
						<div className="heading-date">
							<span className="date-square">
								{new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(
									new Date(),
								)}
							</span>
							<span>
								<small>TODAY</small>
								<b>
									{new Intl.DateTimeFormat(undefined, {
										month: "long",
										year: "numeric",
									}).format(new Date())}
								</b>
							</span>
						</div>
					</div>
					{saveMutation.isError && (
						<div className="notice error" role="alert">
							Couldn’t save this change.{" "}
							{saveMutation.error instanceof Error
								? saveMutation.error.message
								: "Please try again."}
						</div>
					)}
					{saveMutation.isSuccess && (
						<div className="save-status" role="status">
							Saved just now
						</div>
					)}
					{boardQuery.isPending ? (
						<div className="loading-panel">
							<span className="spinner" />
							Opening your board…
						</div>
					) : boardQuery.isError ? (
						<div className="empty-panel error-panel">
							<span className="empty-icon">!</span>
							<h2>We couldn’t reach the board.</h2>
							<p>
								{boardQuery.error instanceof Error
									? boardQuery.error.message
									: "Check your connection or access token, then try again."}
							</p>
							<button
								className="button primary"
								onClick={() => boardQuery.refetch()}
							>
								Try again
							</button>
							<button
								className="text-button"
								onClick={() => setShowToken(true)}
							>
								Access settings
							</button>
						</div>
					) : board ? (
						<>
							{section === "today" && (
								<Today board={board} onNavigate={setSection} />
							)}
							{section === "targets" && (
								<Targets board={board} onSave={persist} />
							)}
							{section === "strategy" && (
								<Strategy board={board} onSave={persist} />
							)}
							{section === "projects" && (
								<Projects board={board} onSave={persist} />
							)}
							{section === "pricing" && (
								<Pricing board={board} onSave={persist} />
							)}
							{section === "connections" && <Connections board={board} />}
						</>
					) : null}
					<footer className="footer-note">
						<span>OFFICE OFFICE</span>
						<span>Keep the work visible. Keep the day human.</span>
					</footer>
				</div>
			</main>
			{showToken && (
				<div
					className="modal-backdrop"
					role="presentation"
					onMouseDown={(e) => {
						if (e.target === e.currentTarget) setShowToken(false);
					}}
				>
					<section
						className="modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="access-title"
					>
						<button
							className="modal-close"
							aria-label="Close"
							onClick={() => setShowToken(false)}
						>
							×
						</button>
						<div className="eyebrow">WORKSPACE ACCESS</div>
						<h2 id="access-title">Access credentials</h2>
						<p>
							Credentials stay in this browser session. Choose which identity to
							use for board reads and edits.
						</p>
						<form onSubmit={rememberToken}>
							<label htmlFor="identity">Active identity</label>
							<select
								id="identity"
								value={identity}
								onChange={(e) =>
									setIdentity(e.target.value as "human" | "agent")
								}
							>
								<option value="human">Human</option>
								<option value="agent">Agent</option>
							</select>
							<label htmlFor="human-token">Human bearer token</label>
							<input
								id="human-token"
								type="password"
								value={humanToken}
								onChange={(e) => setHumanToken(e.target.value)}
								placeholder="Human access token"
								autoComplete="off"
							/>
							<label htmlFor="agent-token">Agent bearer token</label>
							<input
								autoFocus
								id="agent-token"
								type="password"
								value={agentToken}
								onChange={(e) => setAgentToken(e.target.value)}
								placeholder="Agent access token"
								autoComplete="off"
							/>
							<div className="modal-actions">
								<button
									type="button"
									className="button quiet"
									onClick={() => setShowToken(false)}
								>
									Cancel
								</button>
								<button className="button primary">Save access</button>
							</div>
						</form>
					</section>
				</div>
			)}
		</div>
	);
}

function SectionHeader({
	label,
	action,
	onAction,
}: {
	label: string;
	action?: string;
	onAction?: () => void;
}) {
	return (
		<div className="section-header">
			<div className="section-title">{label}</div>
			{action && (
				<button className="button outline" onClick={onAction}>
					＋ {action}
				</button>
			)}
		</div>
	);
}

function Today({
	board,
	onNavigate,
}: {
	board: Board;
	onNavigate: (s: Section) => void;
}) {
	const active = board.projects.filter((p) => p.status !== "archived");
	const inMotion = active.filter((p) => p.status !== "on_hold");
	return (
		<div className="today-layout">
			<section className="today-main">
				<div className="welcome-note">
					<div className="welcome-symbol">✳</div>
					<div>
						<span className="eyebrow">A NOTE FOR TODAY</span>
						<p>Make room for the work that matters.</p>
						<small>Your office board is ready when you are.</small>
					</div>
				</div>
				<SectionHeader
					label="In motion"
					action="View projects"
					onAction={() => onNavigate("projects")}
				/>
				{inMotion.length ? (
					<div className="project-list">
						{inMotion.slice(0, 4).map((project) => (
							<ProjectRow key={project.id} project={project} />
						))}
					</div>
				) : (
					<QuietEmpty
						title="Nothing in motion yet"
						description="Add a project when something needs a place on the board."
						action="Start a project"
						onClick={() => onNavigate("projects")}
					/>
				)}
				<SectionHeader
					label="Recent notes"
					action="Add a note"
					onAction={() => onNavigate("strategy")}
				/>
				{board.updates.length ? (
					<div className="note-list">
						{board.updates.slice(0, 3).map((note) => (
							<div key={note.id} className="note-row">
								<span className="note-bullet" />
								<div>
									<b>{note.title}</b>
									{note.detail && <p>{note.detail}</p>}
								</div>
								<time>{note.status ? dateLabel(note.status) : "Just now"}</time>
							</div>
						))}
					</div>
				) : (
					<QuietEmpty
						title="A little space for notes"
						description="Capture decisions and small updates so the whole team can catch up."
						action="Add a note"
						onClick={() => onNavigate("strategy")}
						compact
					/>
				)}
			</section>
			<aside className="today-side">
				<div className="side-card targets-card">
					<div className="side-card-head">
						<span>YOUR TARGETS</span>
						<button
							aria-label="View targets"
							onClick={() => onNavigate("targets")}
						>
							↗
						</button>
					</div>
					{board.targets.length ? (
						board.targets
							.slice(0, 3)
							.map((t) => <TargetMini key={t.id} target={t} />)
					) : (
						<div className="side-empty">
							<span className="target-ring">◎</span>
							<b>Pick a direction</b>
							<p>Add one or two targets to give the week a useful shape.</p>
							<button
								className="text-button"
								onClick={() => onNavigate("targets")}
							>
								Set a target <span>→</span>
							</button>
						</div>
					)}
				</div>
				<div className="side-card pulse-card">
					<span className="eyebrow">AT A GLANCE</span>
					<div className="pulse-stat">
						<b>{inMotion.length.toString().padStart(2, "0")}</b>
						<span>active projects</span>
					</div>
					<div className="pulse-rule" />
					<div className="pulse-stat">
						<b>
							{active
								.filter((p) => p.status === "on_hold")
								.length.toString()
								.padStart(2, "0")}
						</b>
						<span>on hold</span>
					</div>
					<button
						className="text-button"
						onClick={() => onNavigate("projects")}
					>
						See all work <span>→</span>
					</button>
				</div>
				<div className="help-note">
					<span>✦</span>
					<p>Good boards stay small. Keep what helps the next conversation.</p>
				</div>
			</aside>
		</div>
	);
}

function TargetMini({ target }: { target: Target }) {
	const progress =
		target.target && target.current != null
			? Math.max(0, Math.min(100, (target.current / target.target) * 100))
			: null;
	return (
		<div className="target-mini">
			<div className="target-label">
				<span>{target.title}</span>
				{progress != null && <small>{Math.round(progress)}%</small>}
			</div>
			{progress != null && (
				<div className="progress-track">
					<span style={{ width: `${progress}%` }} />
				</div>
			)}
			{target.detail && (
				<small className="target-detail">{target.detail}</small>
			)}
		</div>
	);
}

function ProjectRow({ project }: { project: Entry }) {
	return (
		<article className="project-row">
			<span
				className={`project-mark ${project.status === "on_hold" ? "paused" : ""}`}
			>
				◦
			</span>
			<div className="project-copy">
				<b>{project.title}</b>
				{project.detail && <p>{project.detail}</p>}
			</div>
			<span
				className={`status-pill ${project.status === "on_hold" ? "amber" : "green"}`}
			>
				{project.status === "on_hold" ? "On hold" : "Active"}
			</span>
			<span className="row-arrow">↗</span>
		</article>
	);
}

function QuietEmpty({
	title,
	description,
	action,
	onClick,
	compact = false,
}: {
	title: string;
	description: string;
	action?: string;
	onClick?: () => void;
	compact?: boolean;
}) {
	return (
		<div className={`quiet-empty ${compact ? "compact" : ""}`}>
			<span className="empty-dash" />
			<div>
				<b>{title}</b>
				<p>{description}</p>
			</div>
			{action && (
				<button className="text-button" onClick={onClick}>
					{action} <span>→</span>
				</button>
			)}
		</div>
	);
}

function ItemForm({
	label,
	onSubmit,
	onCancel,
}: {
	label: string;
	onSubmit: (title: string, detail: string) => void | Promise<void>;
	onCancel: () => void;
}) {
	const form = useForm({
		defaultValues: { title: "", detail: "" },
		onSubmit: async ({ value }) =>
			onSubmit(value.title.trim(), value.detail.trim()),
	});
	return (
		<form
			className="inline-form"
			onSubmit={(e) => {
				e.preventDefault();
				e.stopPropagation();
				void form.handleSubmit();
			}}
		>
			<form.Field
				name="title"
				validators={{
					onChange: v.pipe(
						v.string(),
						v.trim(),
						v.minLength(1, "Add a name."),
						v.maxLength(120, "Keep the name under 120 characters."),
					),
				}}
			>
				{(field) => (
					<label>
						<span>{label} name</span>
						<input
							autoFocus
							value={field.state.value}
							onBlur={field.handleBlur}
							onChange={(e) => field.handleChange(e.target.value)}
							placeholder="Give it a clear name"
							aria-invalid={field.state.meta.errors.length > 0}
						/>
						{field.state.meta.errors.length > 0 && (
							<small className="field-error">
								{field.state.meta.errors[0]?.toString()}
							</small>
						)}
					</label>
				)}
			</form.Field>
			<form.Field
				name="detail"
				validators={{
					onChange: v.pipe(
						v.string(),
						v.maxLength(500, "Keep details under 500 characters."),
					),
				}}
			>
				{(field) => (
					<label>
						<span>A few useful details</span>
						<textarea
							value={field.state.value}
							onBlur={field.handleBlur}
							onChange={(e) => field.handleChange(e.target.value)}
							placeholder="What should the team know?"
							rows={2}
							aria-invalid={field.state.meta.errors.length > 0}
						/>
						{field.state.meta.errors.length > 0 && (
							<small className="field-error">
								{field.state.meta.errors[0]?.toString()}
							</small>
						)}
					</label>
				)}
			</form.Field>
			<div className="form-actions">
				<button type="button" className="button quiet" onClick={onCancel}>
					Cancel
				</button>
				<button className="button primary">Add {label.toLowerCase()}</button>
			</div>
		</form>
	);
}

function Targets({
	board,
	onSave,
}: {
	board: Board;
	onSave: (b: Board) => Promise<boolean>;
}) {
	const [adding, setAdding] = useState(false);
	return (
		<div className="single-column">
			<SectionHeader
				label={`${board.targets.length} ${board.targets.length === 1 ? "target" : "targets"}`}
				action={adding ? undefined : "Add target"}
				onAction={() => setAdding(true)}
			/>
			{adding && (
				<ItemForm
					label="Target"
					onCancel={() => setAdding(false)}
					onSubmit={async (title, detail) => {
						const saved = await onSave({
							...board,
							targets: [
								...board.targets,
								{
									id: id(),
									title,
									detail,
									status: "active",
									current: 0,
									target: 1,
									unit: "items",
								},
							],
						});
						if (saved) setAdding(false);
					}}
				/>
			)}
			<div className="card-list">
				{board.targets.map((target) => (
					<TargetCard
						key={`${target.id}:${target.current}:${target.target}:${target.unit}`}
						target={target}
						onSave={async (next) =>
							onSave({
								...board,
								targets: board.targets.map((x) =>
									x.id === target.id ? next : x,
								),
							})
						}
						onDelete={() => {
							void onSave({
								...board,
								targets: board.targets.filter((x) => x.id !== target.id),
							});
						}}
					/>
				))}
			</div>
			{!board.targets.length && !adding && (
				<QuietEmpty
					title="Start with a direction"
					description="A useful target gives the team something concrete to move toward."
					action="Add your first target"
					onClick={() => setAdding(true)}
				/>
			)}
		</div>
	);
}

function TargetCard({
	target,
	onSave,
	onDelete,
}: {
	target: Target;
	onSave: (t: Target) => Promise<boolean>;
	onDelete: () => void;
}) {
	const form = useForm({
		defaultValues: {
			current: String(target.current ?? 0),
			target: String(target.target ?? 1),
			unit: target.unit ?? "items",
		},
		onSubmit: async ({ value }) => {
			await onSave({
				...target,
				current: Number(value.current),
				target: Number(value.target),
				unit: value.unit.trim(),
			});
		},
	});
	const pct =
		target.target && target.current != null
			? Math.max(0, Math.min(100, (target.current / target.target) * 100))
			: null;
	const numeric = (min: number, message: string) =>
		v.pipe(
			v.string(),
			v.regex(/^\d+(\.\d+)?$/, "Enter a valid number."),
			v.transform(Number),
			v.check((value) => value >= min, message),
		);
	return (
		<article className="data-card">
			<form
				className="target-progress-form"
				onSubmit={(e) => {
					e.preventDefault();
					e.stopPropagation();
					void form.handleSubmit();
				}}
			>
				<div className="data-card-top">
					<span className="card-kicker">TARGET</span>
					<button
						type="button"
						className="delete-button"
						aria-label={`Remove ${target.title}`}
						onClick={onDelete}
					>
						×
					</button>
				</div>
				<h3>{target.title}</h3>
				{target.detail && <p>{target.detail}</p>}
				<div className="target-editor">
					<form.Field
						name="current"
						validators={{
							onChange: numeric(0, "Current progress cannot be negative."),
						}}
					>
						{(field) => (
							<label>
								Current
								<input
									type="number"
									min="0"
									step="any"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									aria-invalid={field.state.meta.errors.length > 0}
								/>
								{field.state.meta.errors.length > 0 && (
									<small className="field-error">
										{field.state.meta.errors[0]?.toString()}
									</small>
								)}
							</label>
						)}
					</form.Field>
					<span className="target-of">of</span>
					<form.Field
						name="target"
						validators={{
							onChange: numeric(
								Number.MIN_VALUE,
								"Target must be greater than zero.",
							),
						}}
					>
						{(field) => (
							<label>
								Target
								<input
									type="number"
									min="0.000001"
									step="any"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									aria-invalid={field.state.meta.errors.length > 0}
								/>
								{field.state.meta.errors.length > 0 && (
									<small className="field-error">
										{field.state.meta.errors[0]?.toString()}
									</small>
								)}
							</label>
						)}
					</form.Field>
					<form.Field
						name="unit"
						validators={{
							onChange: v.pipe(
								v.string(),
								v.trim(),
								v.minLength(1, "Enter a unit."),
								v.maxLength(40, "Keep the unit under 40 characters."),
							),
						}}
					>
						{(field) => (
							<label>
								Unit
								<input
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="e.g. calls"
									aria-invalid={field.state.meta.errors.length > 0}
								/>
								{field.state.meta.errors.length > 0 && (
									<small className="field-error">
										{field.state.meta.errors[0]?.toString()}
									</small>
								)}
							</label>
						)}
					</form.Field>
				</div>
				{pct != null && (
					<div className="progress-track large">
						<span style={{ width: `${pct}%` }} />
					</div>
				)}
				<div className="form-actions">
					<button className="button primary">Save progress</button>
				</div>
			</form>
		</article>
	);
}

function Strategy({
	board,
	onSave,
}: {
	board: Board;
	onSave: (b: Board) => Promise<boolean>;
}) {
	const [adding, setAdding] = useState(false);
	const [note, setNote] = useState(false);
	return (
		<div className="single-column">
			<div className="strategy-intro">
				<span>✦</span>
				<p>
					Write down the thinking that helps people make good decisions when you
					are not in the room.
				</p>
			</div>
			<SectionHeader
				label="Working principles"
				action={adding ? undefined : "Add principle"}
				onAction={() => setAdding(true)}
			/>
			{adding && (
				<ItemForm
					label="Principle"
					onCancel={() => setAdding(false)}
					onSubmit={async (title, detail) => {
						if (
							await onSave({
								...board,
								strategies: [...board.strategies, { id: id(), title, detail }],
							})
						)
							setAdding(false);
					}}
				/>
			)}
			<div className="principle-list">
				{board.strategies.map((item, i) => (
					<article key={item.id} className="principle-card">
						<span className="principle-number">
							{String(i + 1).padStart(2, "0")}
						</span>
						<div>
							<h3>{item.title}</h3>
							{item.detail && <p>{item.detail}</p>}
						</div>
						<button
							className="delete-button"
							aria-label={`Remove ${item.title}`}
							onClick={() => {
								void onSave({
									...board,
									strategies: board.strategies.filter((x) => x.id !== item.id),
								});
							}}
						>
							×
						</button>
					</article>
				))}
			</div>
			{!board.strategies.length && !adding && (
				<QuietEmpty
					title="Give your work a north star"
					description="Add a principle the team can use to guide day-to-day choices."
					action="Add a principle"
					onClick={() => setAdding(true)}
				/>
			)}
			<SectionHeader
				label="Team notes"
				action={note ? undefined : "Add a note"}
				onAction={() => setNote(true)}
			/>
			{note && (
				<ItemForm
					label="Note"
					onCancel={() => setNote(false)}
					onSubmit={async (title, detail) => {
						if (
							await onSave({
								...board,
								updates: [
									{
										id: id(),
										title,
										detail,
										status: new Date().toISOString().slice(0, 10),
									},
									...board.updates,
								],
							})
						)
							setNote(false);
					}}
				/>
			)}
			<div className="note-list bordered">
				{board.updates.map((item) => (
					<div key={item.id} className="note-row">
						<span className="note-bullet" />
						<div>
							<b>{item.title}</b>
							{item.detail && <p>{item.detail}</p>}
						</div>
						<time>{dateLabel(item.status)}</time>
						<button
							className="delete-button"
							aria-label={`Remove ${item.title}`}
							onClick={() => {
								void onSave({
									...board,
									updates: board.updates.filter((x) => x.id !== item.id),
								});
							}}
						>
							×
						</button>
					</div>
				))}
			</div>
		</div>
	);
}

function Projects({
	board,
	onSave,
}: {
	board: Board;
	onSave: (b: Board) => Promise<boolean>;
}) {
	const [adding, setAdding] = useState(false);
	const [filter, setFilter] = useState("active");
	const filtered = board.projects.filter(
		(p) =>
			filter === "all" ||
			(filter === "active"
				? p.status !== "on_hold" && p.status !== "archived"
				: p.status === filter),
	);
	function change(project: Entry, status: string) {
		void onSave({
			...board,
			projects: board.projects.map((p) =>
				p.id === project.id ? { ...p, status } : p,
			),
		});
	}
	return (
		<div className="single-column">
			<div className="filter-row">
				<div
					className="filter-tabs"
					role="tablist"
					aria-label="Filter projects"
				>
					{[
						["active", "Active"],
						["on_hold", "On hold"],
						["archived", "Archived"],
						["all", "All"],
					].map(([value, label]) => (
						<button
							key={value}
							role="tab"
							aria-selected={filter === value}
							className={filter === value ? "active" : ""}
							onClick={() => setFilter(value)}
						>
							{label}
							<span>
								{
									board.projects.filter(
										(p) =>
											value === "all" ||
											(value === "active"
												? p.status !== "on_hold" && p.status !== "archived"
												: p.status === value),
									).length
								}
							</span>
						</button>
					))}
				</div>
				<button className="button primary" onClick={() => setAdding(!adding)}>
					＋ New project
				</button>
			</div>
			{adding && (
				<ItemForm
					label="Project"
					onCancel={() => setAdding(false)}
					onSubmit={async (title, detail) => {
						if (
							await onSave({
								...board,
								projects: [
									...board.projects,
									{ id: id(), title, detail, status: "active" },
								],
							})
						)
							setAdding(false);
					}}
				/>
			)}
			<div className="project-cards">
				{filtered.map((project) => (
					<article className="project-card" key={project.id}>
						<div className="project-card-head">
							<span
								className={`project-glyph ${project.status === "on_hold" ? "paused" : project.status === "archived" ? "archived" : ""}`}
							>
								{project.status === "archived"
									? "✓"
									: project.status === "on_hold"
										? "Ⅱ"
										: "↗"}
							</span>
							<span
								className={`status-pill ${project.status === "on_hold" ? "amber" : project.status === "archived" ? "muted" : "green"}`}
							>
								{project.status === "on_hold"
									? "On hold"
									: project.status === "archived"
										? "Archived"
										: "Active"}
							</span>
						</div>
						<h3>{project.title}</h3>
						<p className="project-card-detail">
							{project.detail || "No details added yet."}
						</p>
						{project.owner && (
							<div className="owner-line">
								<span className="avatar tiny">
									{project.owner.slice(0, 1).toUpperCase()}
								</span>
								{project.owner}
							</div>
						)}
						<div className="project-card-actions">
							{project.status === "active" || !project.status ? (
								<button onClick={() => change(project, "on_hold")}>
									Pause
								</button>
							) : project.status === "on_hold" ? (
								<button onClick={() => change(project, "active")}>
									Resume
								</button>
							) : (
								<button onClick={() => change(project, "active")}>
									Reopen
								</button>
							)}
							{project.status !== "archived" && (
								<button onClick={() => change(project, "archived")}>
									Archive
								</button>
							)}
						</div>
					</article>
				))}
			</div>
			{!filtered.length && !adding && (
				<QuietEmpty
					title={
						filter === "active"
							? "A clean slate"
							: `No ${filter === "all" ? "projects" : filter.replace("_", " ")} projects`
					}
					description={
						filter === "active"
							? "Start a project to make the work visible to everyone."
							: "Projects will show up here when they move into this group."
					}
					action="Create a project"
					onClick={() => setAdding(true)}
				/>
			)}
		</div>
	);
}

function Pricing({
	board,
	onSave,
}: {
	board: Board;
	onSave: (b: Board) => Promise<boolean>;
}) {
	const [adding, setAdding] = useState(false);
	const projectMap = useMemo(
		() => new Map(board.projects.map((p) => [p.id, p.title])),
		[board.projects],
	);
	const form = useForm({
		defaultValues: {
			projectId: "",
			amount: "",
			currency: "INR",
			effectiveOn: new Date().toISOString().slice(0, 10),
			detail: "",
		},
		onSubmit: async ({ value }) => {
			const price: Price = {
				id: id(),
				projectId: value.projectId || undefined,
				amountMinor: Math.round(Number(value.amount) * 100),
				currency: value.currency,
				effectiveOn: value.effectiveOn,
				detail: value.detail.trim() || undefined,
			};
			if (!(await onSave({ ...board, prices: [price, ...board.prices] })))
				return;
			setAdding(false);
			form.reset();
		},
	});
	return (
		<div className="single-column">
			<SectionHeader
				label="Price changes"
				action={adding ? undefined : "Record a price"}
				onAction={() => setAdding(true)}
			/>
			{adding && (
				<form
					className="inline-form price-form"
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						void form.handleSubmit();
					}}
				>
					<form.Field name="projectId">
						{(field) => (
							<label>
								<span>Project</span>
								<select
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
								>
									<option value="">Office wide</option>
									{board.projects.map((p) => (
										<option key={p.id} value={p.id}>
											{p.title}
										</option>
									))}
								</select>
							</label>
						)}
					</form.Field>
					<form.Field
						name="amount"
						validators={{
							onChange: v.pipe(
								v.string(),
								v.minLength(1, "Enter an amount."),
								v.regex(
									/^\d+(\.\d{1,2})?$/,
									"Use a non-negative amount with up to two decimal places.",
								),
							),
						}}
					>
						{(field) => (
							<label>
								<span>Amount</span>
								<div className="amount-input">
									<form.Field name="currency">
										{(currency) => (
											<select
												aria-label="Currency"
												value={currency.state.value}
												onChange={(e) => currency.handleChange(e.target.value)}
											>
												{["USD", "EUR", "GBP", "INR", "CAD", "AUD"].map((c) => (
													<option key={c}>{c}</option>
												))}
											</select>
										)}
									</form.Field>
									<input
										type="number"
										min="0"
										step="0.01"
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="0.00"
										aria-invalid={field.state.meta.errors.length > 0}
									/>
								</div>
								{field.state.meta.errors.length > 0 && (
									<small className="field-error">
										{field.state.meta.errors[0]?.toString()}
									</small>
								)}
							</label>
						)}
					</form.Field>
					<form.Field
						name="effectiveOn"
						validators={{
							onChange: v.pipe(
								v.string(),
								v.minLength(1, "Choose an effective date."),
							),
						}}
					>
						{(field) => (
							<label>
								<span>Effective date</span>
								<input
									type="date"
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
								/>
							</label>
						)}
					</form.Field>
					<form.Field
						name="detail"
						validators={{
							onChange: v.pipe(
								v.string(),
								v.maxLength(300, "Keep context under 300 characters."),
							),
						}}
					>
						{(field) => (
							<label>
								<span>Context</span>
								<input
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="What changed?"
								/>
							</label>
						)}
					</form.Field>
					<div className="form-actions">
						<button
							type="button"
							className="button quiet"
							onClick={() => setAdding(false)}
						>
							Cancel
						</button>
						<button className="button primary">Record price</button>
					</div>
				</form>
			)}
			<div className="pricing-table-wrap">
				<table className="pricing-table">
					<thead>
						<tr>
							<th>PROJECT</th>
							<th>AMOUNT</th>
							<th>EFFECTIVE</th>
							<th>CONTEXT</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{board.prices.map((price) => (
							<tr key={price.id}>
								<td>
									<b>
										{price.projectId
											? projectMap.get(price.projectId) || "Removed project"
											: "Office wide"}
									</b>
								</td>
								<td className="amount-cell">
									{new Intl.NumberFormat(undefined, {
										style: "currency",
										currency: price.currency,
									}).format(price.amountMinor / 100)}
								</td>
								<td>{dateLabel(price.effectiveOn)}</td>
								<td className="detail-cell">{price.detail || "—"}</td>
								<td>
									<button
										className="delete-button"
										aria-label="Remove price record"
										onClick={() =>
											onSave({
												...board,
												prices: board.prices.filter((p) => p.id !== price.id),
											})
										}
									>
										×
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{!board.prices.length && !adding && (
					<QuietEmpty
						title="No price history yet"
						description="Record each change as it takes effect to keep a useful history."
						action="Add the first price"
						onClick={() => setAdding(true)}
					/>
				)}
			</div>
		</div>
	);
}

function Connections({ board }: { board: Board }) {
	return (
		<div className="single-column">
			<div className="connection-callout">
				<div className="connection-icon">⇄</div>
				<div>
					<h2>Connected context, kept in its lane.</h2>
					<p>
						External connections are read-only by default. Any allowed write
						action must be explicitly scoped; Hermes handles outbound messages
						separately.
					</p>
				</div>
			</div>
			<SectionHeader label="Configured connections" />
			{board.connectors.length ? (
				<div className="connector-list">
					{board.connectors.map((connector) => (
						<article className="connector-row" key={connector.id}>
							<span className="connector-logo">⇄</span>
							<div className="connector-copy">
								<b>{connector.provider}</b>
								<small>
									{connector.mode} · {connector.syncStatus}
								</small>
							</div>
							<span className="connection-state">
								<span /> {connector.syncStatus}
							</span>
						</article>
					))}
				</div>
			) : (
				<QuietEmpty
					title="No external connections configured"
					description="Connected services will appear here when your workspace adds them."
				/>
			)}
			<div className="connector-footnote">
				Connection setup and access scopes are managed by your workspace
				administrator.
			</div>
		</div>
	);
}
