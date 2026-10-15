import {
	useEffect,
	useMemo,
	useId,
	useState,
	type FormEvent,
	type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import * as v from "valibot";
import Reports from "./Reports";
import TaskDetails from "./TaskDetails";
import {
	bootstrapAdmin,
	createAgentKey,
	getSetupStatus,
	getWorkspace,
	listAgentKeys,
	login,
	revokeAgentKey,
	saveBoard,
	saveCustomer,
	saveMember,
	savePost,
	saveProject,
	saveSettings,
	saveTask,
	type Board,
	type Customer,
	type Task,
	type Member,
	type Project,
	type ScheduledPost,
	type Workspace,
} from "./api";

type Page =
	| "overview"
	| "team"
	| "customers"
	| "projects"
	| "reports"
	| "social"
	| "settings";
type RecordDraft = {
	id: string;
	name: string;
	email: string;
	company: string;
	status: string;
	ownerId: string;
	notes: string;
	jobTitle: string;
	department: string;
	role: string;
	access: string[];
	password: string;
	customerId: string;
	summary: string;
	targetDate: string;
	connectionId: string;
	content: string;
	scheduledAt: string;
	authorId: string;
};
type SaveInput =
	| { kind: "member"; value: Member }
	| { kind: "customer"; value: Customer }
	| { kind: "project"; value: Project }
	| { kind: "post"; value: ScheduledPost }
	| { kind: "settings"; value: Workspace["settings"] };
const nav: { id: Page; label: string; icon: string }[] = [
	{ id: "overview", label: "Overview", icon: "⌂" },
	{ id: "team", label: "Team", icon: "♧" },
	{ id: "customers", label: "Customers", icon: "◎" },
	{ id: "projects", label: "Projects", icon: "▤" },
	{ id: "reports", label: "Reports", icon: "⌕" },
	{ id: "social", label: "Social queue", icon: "◷" },
	{ id: "settings", label: "Settings", icon: "⚙" },
];
const themes = [
	"light",
	"dark",
	"cupcake",
	"bumblebee",
	"emerald",
	"corporate",
	"synthwave",
	"retro",
	"cyberpunk",
	"valentine",
	"halloween",
	"garden",
	"forest",
	"aqua",
	"lofi",
	"pastel",
	"fantasy",
	"wireframe",
	"black",
	"luxury",
	"dracula",
	"cmyk",
	"autumn",
	"business",
	"acid",
	"lemonade",
	"night",
	"coffee",
	"winter",
	"dim",
	"nord",
	"sunset",
	"caramellatte",
	"abyss",
	"silk",
];
const tokenKey = "office-office-session";
const initialTheme = localStorage.getItem("office-office-theme") || "light";
const title: Record<Page, string> = {
	overview: "Your office, at a glance",
	team: "Team",
	customers: "Customers",
	projects: "Projects",
	reports: "Reports",
	social: "Social queue",
	settings: "Settings",
};
const dateText = (value?: string) => {
	if (!value) return "No date";
	const date = new Date(value + (value.length === 10 ? "T12:00:00" : ""));
	return Number.isNaN(date.getTime())
		? "Date unavailable"
		: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
};
const initials = (name: string) =>
	name
		.split(/\s+/)
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();

export default function App() {
	const [sessionToken, setSessionToken] = useState(
		() => sessionStorage.getItem(tokenKey) || "",
	);
	const [page, setPage] = useState<Page>("overview");
	const [navigationOpen, setNavigationOpen] = useState(false);
	const [theme, setTheme] = useState(initialTheme);
	const [dialog, setDialog] = useState<
		null | "member" | "customer" | "project" | "post"
	>(null);
	const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
	const [secretToReveal, setSecretToReveal] = useState("");
	const queryClient = useQueryClient();
	const setup = useQuery({
		queryKey: ["setup"],
		queryFn: getSetupStatus,
		retry: false,
	});
	const workspace = useQuery({
		queryKey: ["workspace"],
		queryFn: getWorkspace,
		enabled: !!sessionToken,
		retry: false,
	});
	const sessionMutation = useMutation({
		mutationFn: async (
			payload:
				| { mode: "login"; email: string; password: string }
				| {
						mode: "setup";
						name: string;
						email: string;
						password: string;
						workspaceName: string;
						loadDemoData: boolean;
				  },
		) =>
			payload.mode === "login"
				? login(payload.email, payload.password)
				: bootstrapAdmin(payload),
		onSuccess: (session) => {
			sessionStorage.setItem(tokenKey, session.token);
			setSessionToken(session.token);
			queryClient.invalidateQueries();
		},
	});
	const data = workspace.data;
	useEffect(() => {
		if (
			data?.settings.defaultTheme &&
			!localStorage.getItem("office-office-theme")
		) {
			setTheme(data.settings.defaultTheme);
			document.documentElement.dataset.theme = data.settings.defaultTheme;
		}
	}, [data?.settings.defaultTheme]);
	const me = data?.currentUser;
	const canManageTeam = me?.role === "admin";
	const canWrite = (area: string) =>
		me?.role === "admin" ||
		(me?.role !== "viewer" && !!me?.access.includes(area));
	const canView = (area: Page) =>
		area === "overview" ||
		area === "settings" ||
		me?.role === "admin" ||
		!!me?.access.includes(area);
	const navigate = (next: Page) => {
		if (canView(next)) {
			setPage(next);
			setNavigationOpen(false);
		}
	};
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);
	function updateTheme(value: string) {
		setTheme(value);
		localStorage.setItem("office-office-theme", value);
		document.documentElement.dataset.theme = value;
	}
	function signOut() {
		setNavigationOpen(false);
		sessionStorage.removeItem(tokenKey);
		setSessionToken("");
		setPage("overview");
		setDialog(null);
		setEditing(null);
		setSecretToReveal("");
		queryClient.clear();
	}
	function edit(kind: NonNullable<typeof dialog>, item?: object) {
		setEditing(item ? { ...item } : null);
		setDialog(kind);
	}
	function refresh() {
		void queryClient.invalidateQueries({ queryKey: ["workspace"] });
		setDialog(null);
		setEditing(null);
	}
	const mutation = useMutation({
		mutationFn: async (payload: SaveInput) => {
			if (payload.kind === "member") return saveMember(payload.value);
			if (payload.kind === "customer") return saveCustomer(payload.value);
			if (payload.kind === "project") return saveProject(payload.value);
			if (payload.kind === "post") return savePost(payload.value);
			return saveSettings(payload.value);
		},
		onSuccess: refresh,
	});

	if (setup.isPending)
		return (
			<div className="min-h-screen grid place-items-center">
				<span
					className="loading loading-spinner loading-lg"
					aria-label="Checking workspace"
				/>
			</div>
		);
	if (setup.isError)
		return (
			<FullError
				message={setup.error.message}
				retry={() => void setup.refetch()}
			/>
		);
	if (setup.data?.needsSetup && !sessionToken)
		return (
			<AuthPage
				mode="setup"
				demoMode={setup.data.demoMode}
				persistentStorage={setup.data.persistentStorage}
				busy={sessionMutation.isPending}
				error={sessionMutation.error?.message}
				onSubmit={(value) =>
					sessionMutation.mutate({
						mode: "setup",
						name: value.name ?? "",
						workspaceName: value.workspaceName ?? "My office",
						email: value.email,
						password: value.password,
						loadDemoData: value.loadDemoData ?? false,
					})
				}
			/>
		);
	if (!sessionToken)
		return (
			<AuthPage
				mode="login"
				demoMode={setup.data?.demoMode ?? false}
				persistentStorage={setup.data?.persistentStorage ?? false}
				busy={sessionMutation.isPending}
				error={sessionMutation.error?.message}
				onSubmit={(value) =>
					sessionMutation.mutate({
						mode: "login",
						email: value.email,
						password: value.password,
					})
				}
			/>
		);
	if (workspace.isPending)
		return (
			<div className="min-h-screen grid place-items-center gap-3">
				<span className="loading loading-spinner loading-lg" />
				<span>Opening your office…</span>
			</div>
		);
	if (workspace.isError)
		return (
			<FullError
				message={workspace.error.message}
				retry={() => void workspace.refetch()}
				signOut={signOut}
			/>
		);
	if (!data || !me) return null;
	const counts = {
		projects: data.projects.filter((x) => x.status === "active").length,
		customers: data.customers.length,
		queued: data.posts.filter(
			(x) => x.status === "queued" || x.status === "needs_review",
		).length,
	};
	const heading = title[page];
	const saveRecord = (kind: NonNullable<typeof dialog>, draft: RecordDraft) => {
		if (kind === "member")
			mutation.mutate({
				kind,
				value: {
					id: draft.id,
					name: draft.name,
					email: draft.email,
					jobTitle: draft.jobTitle,
					department: draft.department,
					role: draft.role,
					status: draft.status,
					access: draft.access,
					password: draft.password,
				},
			});
		if (kind === "customer")
			mutation.mutate({
				kind,
				value: {
					id: draft.id,
					name: draft.name,
					company: draft.company,
					email: draft.email,
					status: draft.status,
					ownerId: draft.ownerId,
					notes: draft.notes,
				},
			});
		if (kind === "project")
			mutation.mutate({
				kind,
				value: {
					id: draft.id,
					name: draft.name,
					customerId: draft.customerId,
					ownerId: draft.ownerId,
					status: draft.status,
					summary: draft.summary,
					targetDate: draft.targetDate,
				},
			});
		if (kind === "post")
			mutation.mutate({
				kind,
				value: {
					id: draft.id,
					connectionId: draft.connectionId,
					content: draft.content,
					scheduledAt: draft.scheduledAt,
					status: draft.status,
					authorId: draft.authorId,
				},
			});
	};
	return (
		<div
			className="min-h-screen bg-base-200 text-base-content"
			data-theme={theme}
		>
			<div className="drawer lg:drawer-open min-h-screen">
				<input
					id="office-drawer"
					type="checkbox"
					className="drawer-toggle"
					checked={navigationOpen}
					onChange={(event) => setNavigationOpen(event.target.checked)}
				/>
				<div className="drawer-content flex min-h-screen flex-col">
					<header className="navbar sticky top-0 z-20 min-h-16 border-b border-base-300 bg-base-100/95 px-4 backdrop-blur sm:px-7">
						<div className="flex-none lg:hidden">
							<label
								htmlFor="office-drawer"
								className="btn btn-square btn-ghost"
								aria-label="Open navigation"
							>
								☰
							</label>
						</div>
						<div className="flex-1">
							<div className="breadcrumbs text-sm">
								<ul>
									<li>Office</li>
									<li aria-current="page">{heading}</li>
								</ul>
							</div>
						</div>
						<div className="flex-none gap-2">
							<div className="badge badge-success badge-outline gap-1">
								● {data.demoMode ? "Sample data" : "Office data"} ·{" "}
								{data.persistentStorage ? "SQLite saved" : "In-memory"}
							</div>
							<div className="dropdown dropdown-end">
								<button
									className="btn btn-ghost btn-circle avatar placeholder"
									aria-label="Account menu"
								>
									<span className="rounded-full bg-primary text-primary-content">
										{initials(me.name)}
									</span>
								</button>
								<ul className="menu dropdown-content z-30 mt-3 w-48 rounded-box bg-base-100 p-2 shadow">
									<li>
										<button onClick={() => setPage("settings")}>
											Settings
										</button>
									</li>
									<li>
										<button onClick={signOut}>Sign out</button>
									</li>
								</ul>
							</div>
						</div>
					</header>
					<main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-7 lg:p-9">
						<div className="mb-6 flex flex-wrap items-end justify-between gap-4">
							<div>
								<p className="text-sm font-medium text-primary">
									{data.settings.workspaceName}
								</p>
								<h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
									{heading}
								</h1>
								<p className="mt-2 max-w-2xl text-base-content/70">
									A clear place for the people, customers, and work moving
									through your office.
								</p>
							</div>
							{page !== "settings" && (
								<div className="hidden items-center gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-2 text-sm sm:flex">
									<span className="avatar placeholder">
										<span className="w-8 rounded-full bg-secondary text-secondary-content">
											{initials(me.name)}
										</span>
									</span>
									<span>
										<b className="block">{me.name}</b>
										<span className="text-base-content/60">{me.jobTitle}</span>
									</span>
								</div>
							)}
						</div>
						<div
							className={`alert mb-6 border text-sm shadow-sm ${data.demoMode ? "border-warning/20 bg-warning/10" : "border-info/20 bg-info/10"}`}
						>
							<span aria-hidden="true">ⓘ</span>
							{data.demoMode ? (
								<span>
									<b>Sample starter data loaded.</b>{" "}
									{data.persistentStorage
										? "Sample records are saved in SQLite and survive restarts."
										: "Sample records and changes reset when the server restarts."}{" "}
									No posts or invitations are sent.
								</span>
							) : (
								<span>
									<b>
										{data.persistentStorage
											? "Saved in SQLite."
											: "In-memory workspace."}
									</b>{" "}
									{data.persistentStorage
										? "Workspace records persist across restarts."
										: "Workspace records reset when the server restarts."}{" "}
									External connectors and social posting are not available yet.
								</span>
							)}
						</div>
						{me.role === "viewer" && (
							<div className="alert mb-6 border border-info/20 bg-info/10 text-sm">
								<span aria-hidden="true">ⓘ</span>
								<span>
									You have read-only access. Your administrator manages
									workspace changes.
								</span>
							</div>
						)}
						{mutation.isError && (
							<div role="alert" className="alert alert-error mb-5">
								{mutation.error.message}
							</div>
						)}
						{page === "overview" && (
							<Overview
								data={data}
								counts={counts}
								navigate={navigate}
								canView={canView}
							/>
						)}
						{page === "team" && (
							<Team
								members={data.members}
								canEdit={canManageTeam}
								onEdit={(person) => edit("member", person)}
								onAdd={() => edit("member")}
							/>
						)}
						{page === "customers" && (
							<Customers
								items={data.customers}
								canEdit={canWrite("customers")}
								onEdit={(item) => edit("customer", item)}
								onAdd={() => edit("customer")}
							/>
						)}
						{page === "projects" && (
							<Projects
								items={data.projects}
								boards={data.boards}
								tasks={data.tasks}
								customers={data.customers}
								members={data.members}
								currentUser={me}
								canEdit={canWrite("projects")}
								canReadReports={canView("reports")}
								currentUserId={me.id}
								onSaveBoard={async (board) => {
									await saveBoard(board);
									await queryClient.invalidateQueries({
										queryKey: ["workspace"],
									});
								}}
								onSaveTask={async (task) => {
									await saveTask(task);
									await queryClient.invalidateQueries({
										queryKey: ["workspace"],
									});
								}}
								onEdit={(item) => edit("project", item)}
								onAdd={() => edit("project")}
							/>
						)}
						{page === "social" && (
							<Social
								items={data.posts}
								connections={data.connections}
								demoMode={data.demoMode}
								persistentStorage={data.persistentStorage}
								canEdit={canWrite("social")}
								onEdit={(item) => edit("post", item)}
								onAdd={() => edit("post")}
							/>
						)}
						{page === "reports" && (
							<Reports
								canEdit={canWrite("reports")}
								currentUser={me}
								members={data.members}
								projects={data.projects}
								tasks={data.tasks}
							/>
						)}
						{page === "settings" && (
							<Settings
								data={data}
								demoMode={data.demoMode}
								persistentStorage={data.persistentStorage}
								canManage={canManageTeam}
								theme={theme}
								onTheme={updateTheme}
								onSave={(value) => mutation.mutate({ kind: "settings", value })}
								secretToReveal={secretToReveal}
								onSecret={(secret) => setSecretToReveal(secret)}
							/>
						)}
					</main>
					<footer className="border-t border-base-300 px-5 py-4 text-center text-sm text-base-content/50">
						Office Office · A shared workspace for good work
					</footer>
				</div>
				<div className="drawer-side z-30">
					<label
						htmlFor="office-drawer"
						aria-label="Close navigation"
						className="drawer-overlay"
					/>
					<aside className="flex min-h-full w-72 flex-col border-r border-base-300 bg-base-100 p-4">
						<a
							href="#overview"
							onClick={(e) => {
								e.preventDefault();
								setPage("overview");
							}}
							className="mb-8 flex items-center gap-3 rounded-box px-2 py-3"
						>
							<span className="grid size-11 place-items-center rounded-xl bg-primary text-xl font-semibold text-primary-content">
								oo
							</span>
							<span>
								<b className="block text-lg leading-tight">office office</b>
								<span className="text-sm text-base-content/60">
									THE SHARED WORKSPACE
								</span>
							</span>
						</a>
						<div className="mb-2 px-3 text-sm font-semibold uppercase tracking-wider text-base-content/50">
							Workspace
						</div>
						<ul className="menu gap-1 p-0">
							{nav
								.filter((item) => canView(item.id))
								.map((item) => (
									<li key={item.id}>
										<button
											className={page === item.id ? "active" : ""}
											aria-current={page === item.id ? "page" : undefined}
											onClick={() => navigate(item.id)}
										>
											<span
												className="w-6 text-center text-lg"
												aria-hidden="true"
											>
												{item.icon}
											</span>
											{item.label}
											{item.id === "projects" && counts.projects > 0 && (
												<span className="badge badge-sm ml-auto">
													{counts.projects}
												</span>
											)}
										</button>
									</li>
								))}
						</ul>
						<div className="mt-auto rounded-box bg-base-200 p-3">
							<div className="flex items-center gap-3">
								<div className="avatar placeholder">
									<div className="w-10 rounded-full bg-secondary text-secondary-content">
										<span>{initials(me.name)}</span>
									</div>
								</div>
								<div className="min-w-0 flex-1">
									<b className="block truncate text-sm">{me.name}</b>
									<span className="text-sm capitalize text-base-content/60">
										{me.role}
									</span>
								</div>
								<button
									className="btn btn-ghost btn-sm"
									aria-label="Sign out"
									onClick={signOut}
								>
									↗
								</button>
							</div>
						</div>
					</aside>
				</div>
			</div>
			{dialog && (
				<RecordDialog
					kind={dialog}
					initial={editing}
					data={data}
					busy={mutation.isPending}
					error={mutation.isError ? mutation.error.message : undefined}
					onClose={() => {
						setDialog(null);
						setEditing(null);
					}}
					onSubmit={(value) => saveRecord(dialog, value)}
				/>
			)}
		</div>
	);
}

function FullError({
	message,
	retry,
	signOut,
}: {
	message: string;
	retry: () => void;
	signOut?: () => void;
}) {
	return (
		<main className="grid min-h-screen place-items-center p-5">
			<section className="card w-full max-w-lg border border-base-300 bg-base-100 shadow">
				<div className="card-body items-center text-center">
					<span className="text-3xl">⌁</span>
					<h1 className="card-title">We couldn’t open the workspace</h1>
					<p className="text-base-content/70">{message}</p>
					<div className="card-actions mt-2">
						<button className="btn btn-primary" onClick={retry}>
							Try again
						</button>
						{signOut && (
							<button className="btn btn-ghost" onClick={signOut}>
								Back to sign in
							</button>
						)}
					</div>
				</div>
			</section>
		</main>
	);
}

function AuthPage({
	mode,
	demoMode,
	persistentStorage,
	busy,
	error,
	onSubmit,
}: {
	mode: "setup" | "login";
	demoMode: boolean;
	persistentStorage: boolean;
	busy: boolean;
	error?: string;
	onSubmit: (value: {
		name?: string;
		email: string;
		password: string;
		workspaceName?: string;
		loadDemoData?: boolean;
	}) => void;
}) {
	const [formError, setFormError] = useState("");
	const [loadDemoData, setLoadDemoData] = useState(demoMode);
	const form = useForm({
		defaultValues: {
			name: "",
			workspaceName: "My office",
			email: "",
			password: "",
			confirm: "",
		},
		onSubmit: async ({ value }) => {
			if (mode === "setup" && value.password !== value.confirm) {
				setFormError("Passwords do not match.");
				return;
			}
			setFormError("");
			onSubmit(mode === "setup" ? { ...value, loadDemoData } : value);
		},
	});
	const field = (
		name: "name" | "workspaceName" | "email" | "password" | "confirm",
		label: string,
		type = "text",
		required = true,
	) => (
		<form.Field
			key={name}
			name={name}
			validators={{
				onBlur: ({ value }) => {
					if (name === "email") {
						const result = v.safeParse(v.pipe(v.string(), v.email()), value);
						return result.success ? undefined : "Enter a valid email address.";
					}
					const minimum =
						name === "password" || name === "confirm"
							? mode === "setup"
								? 12
								: 1
							: required
								? 1
								: 0;
					const result = v.safeParse(
						v.pipe(v.string(), v.minLength(minimum), v.maxLength(160)),
						value,
					);
					return result.success
						? undefined
						: name === "password" || name === "confirm"
							? "Use at least 12 characters."
							: "This field is required.";
				},
			}}
		>
			{(f) => (
				<label className="form-control w-full">
					<span className="label-text mb-2 font-medium">{label}</span>
					<input
						className="input input-bordered w-full"
						type={type}
						autoComplete={
							type === "password"
								? mode === "login"
									? "current-password"
									: "new-password"
								: name === "email"
									? "email"
									: "name"
						}
						value={f.state.value}
						onBlur={f.handleBlur}
						onChange={(e) => f.handleChange(e.target.value)}
						aria-invalid={f.state.meta.errors.length > 0}
					/>
					{f.state.meta.errors[0] && (
						<span className="label-text-alt mt-1 text-error">
							{String(f.state.meta.errors[0])}
						</span>
					)}
				</label>
			)}
		</form.Field>
	);
	return (
		<main className="grid min-h-screen bg-base-200 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
			<section className="hidden flex-col justify-between bg-primary p-12 text-primary-content lg:flex">
				<div className="flex items-center gap-3">
					<span className="grid size-12 place-items-center rounded-xl border border-primary-content/30 text-xl font-semibold">
						oo
					</span>
					<b className="text-xl">office office</b>
				</div>
				<div className="max-w-xl">
					<p className="mb-4 text-sm uppercase tracking-[.2em] opacity-70">
						A calmer way to work together
					</p>
					<h1 className="text-5xl font-semibold leading-tight">
						Keep the work visible. Keep the day human.
					</h1>
					<p className="mt-6 text-lg opacity-75">
						One shared place for your people, customers, projects, and plans.
					</p>
				</div>
				<p className="text-sm opacity-60">A shared office workspace</p>
			</section>
			<section className="grid place-items-center p-5 sm:p-10">
				<div className="w-full max-w-md">
					<div className="mb-8 flex items-center gap-3 lg:hidden">
						<span className="grid size-11 place-items-center rounded-xl bg-primary text-xl text-primary-content">
							oo
						</span>
						<b className="text-lg">office office</b>
					</div>
					<div className="card border border-base-300 bg-base-100 shadow-sm">
						<div className="card-body gap-5 p-6 sm:p-9">
							<div>
								<div className="badge badge-primary badge-outline mb-4">
									{mode === "setup" ? "First time setup" : "Welcome back"}
								</div>
								<h2 className="text-3xl font-semibold">
									{mode === "setup" ? "Create your office" : "Sign in"}
								</h2>
								<p className="mt-2 text-base-content/65">
									{mode === "setup"
										? "Set up your administrator account and workspace."
										: "Use your office account to continue."}
								</p>
							</div>
							{!persistentStorage && (
								<div className="alert border border-warning/20 bg-warning/10 text-sm">
									<span>ⓘ</span>
									<span>
										This in-memory workspace resets when the server restarts.
									</span>
								</div>
							)}
							{persistentStorage && (
								<div className="alert border border-info/20 bg-info/10 text-sm">
									<span>ⓘ</span>
									<span>
										Workspace records are saved in SQLite. External connectors
										and social posting are not available yet.
									</span>
								</div>
							)}
							{(error || formError) && (
								<div role="alert" className="alert alert-error text-sm">
									{error || formError}
								</div>
							)}
							<form
								onSubmit={(e) => {
									e.preventDefault();
									e.stopPropagation();
									void form.handleSubmit();
								}}
								className="grid gap-4"
							>
								{mode === "setup" && (
									<>
										{field("name", "Your name")}
										{field("workspaceName", "Workspace name")}
										<div className="flex items-start gap-3 rounded-box border border-base-300 p-3">
											<input
												id="bootstrap-sample-data"
												type="checkbox"
												className="checkbox checkbox-primary"
												checked={loadDemoData}
												disabled={busy}
												aria-describedby="bootstrap-sample-data-help"
												onChange={(event) =>
													setLoadDemoData(event.target.checked)
												}
											/>
											<div>
												<label
													htmlFor="bootstrap-sample-data"
													className="block cursor-pointer font-semibold"
												>
													Start with sample office data
												</label>
												<p
													id="bootstrap-sample-data-help"
													className="text-sm text-base-content/65"
												>
													Creates sample teammates, customers, projects, boards,
													tasks and a research report. No invitations or posts
													are sent.
												</p>
											</div>
										</div>
									</>
								)}
								{field("email", "Email address", "email")}
								{field("password", "Password", "password")}
								{mode === "setup" &&
									field("confirm", "Confirm password", "password")}
								<button className="btn btn-primary mt-2" disabled={busy}>
									{busy && (
										<span className="loading loading-spinner loading-sm" />
									)}
									{mode === "setup" ? "Create workspace" : "Sign in"}
								</button>
							</form>
							<p className="text-center text-sm text-base-content/55">
								Your account is managed by this workspace.
							</p>
						</div>
					</div>
				</div>
			</section>
		</main>
	);
}

function PageTitle({
	eyebrow,
	heading,
	description,
	action,
}: {
	eyebrow: string;
	heading: string;
	description: string;
	action?: ReactNode;
}) {
	return (
		<div className="mb-5 flex flex-wrap items-end justify-between gap-3">
			<div>
				<p className="text-sm font-semibold uppercase tracking-wider text-base-content/50">
					{eyebrow}
				</p>
				<h2 className="mt-1 text-xl font-semibold">{heading}</h2>
				<p className="mt-1 text-base text-base-content/65">{description}</p>
			</div>
			{action}
		</div>
	);
}
function Overview({
	data,
	counts,
	navigate,
	canView,
}: {
	data: Workspace;
	counts: { projects: number; customers: number; queued: number };
	navigate: (page: Page) => void;
	canView: (page: Page) => boolean;
}) {
	const activity = data.activity.slice(0, 5);
	const allCards: Array<[string, number, Page, string]> = [
		["Active projects", counts.projects, "projects", "primary"],
		["Customers", counts.customers, "customers", "secondary"],
		["In social queue", counts.queued, "social", "accent"],
	];
	const cards = allCards.filter((item) => canView(item[2]));
	return (
		<div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.8fr)]">
			<div className="space-y-6">
				<section>
					<PageTitle
						eyebrow="A quick pulse"
						heading="What’s moving"
						description="A current view of the work the team has in front of it."
					/>
					<div className="grid gap-3 sm:grid-cols-3">
						{cards.map(([label, value, page, color]) => (
							<button
								key={label}
								onClick={() => navigate(page)}
								className={`card border border-base-300 bg-base-100 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow ${color}`}
							>
								<div className="card-body gap-2 p-5">
									<span className="text-sm text-base-content/65">{label}</span>
									<b className="text-3xl">{value}</b>
									<span className="text-sm text-base-content/55">
										View {label.toLowerCase()} →
									</span>
								</div>
							</button>
						))}
					</div>
				</section>
				{canView("projects") && (
					<section className="card border border-base-300 bg-base-100 shadow-sm">
						<div className="card-body">
							<PageTitle
								eyebrow="Project desk"
								heading="Projects in motion"
								description="The active work your team is carrying."
								action={
									<button
										className="btn btn-ghost btn-sm"
										onClick={() => navigate("projects")}
									>
										All projects →
									</button>
								}
							/>
							{data.projects
								.filter((x) => x.status === "active")
								.slice(0, 4)
								.map((p) => (
									<div
										key={p.id}
										className="flex items-center gap-3 border-t border-base-200 py-3"
									>
										<div className="grid size-10 place-items-center rounded-xl bg-primary/10 font-semibold text-primary">
											{initials(p.name)}
										</div>
										<div className="min-w-0 flex-1">
											<b className="block truncate">{p.name}</b>
											<span className="text-sm text-base-content/60">
												{data.customers.find((c) => c.id === p.customerId)
													?.company || "Internal project"}
											</span>
										</div>
										<span className="badge badge-success badge-outline">
											Active
										</span>
									</div>
								))}
							{!data.projects.some((x) => x.status === "active") && (
								<Empty
									title="No active projects yet"
									body="When a project starts, it will show up here."
									action="View projects"
									onClick={() => navigate("projects")}
								/>
							)}
						</div>
					</section>
				)}
			</div>
			<div className="space-y-6">
				<section className="card border border-base-300 bg-base-100 shadow-sm">
					<div className="card-body">
						<PageTitle
							eyebrow="Recent activity"
							heading="Around the office"
							description="The latest recorded workspace updates."
						/>
						{activity.length ? (
							<ul className="timeline timeline-vertical timeline-compact">
								{activity.map((item) => (
									<li key={item.id}>
										<div className="timeline-middle">
											<span className="grid size-7 place-items-center rounded-full bg-base-200 text-sm">
												•
											</span>
										</div>
										<div className="timeline-end mb-4 ml-3 w-full">
											<div className="text-sm">{item.summary}</div>
											<div className="mt-1 text-sm text-base-content/55">
												{item.actorName} · {dateText(item.occurredAt)}
											</div>
										</div>
										<hr />
									</li>
								))}
							</ul>
						) : (
							<Empty
								title="A little quiet here"
								body="Updates will appear as your team records work."
							/>
						)}
					</div>
				</section>
				<section className="card border border-base-300 bg-base-100 shadow-sm">
					<div className="card-body">
						<p className="text-sm font-semibold uppercase tracking-wider text-base-content/50">
							Quick links
						</p>
						<div className="menu mt-2 rounded-box bg-base-200 p-2">
							{canView("customers") && (
								<li>
									<button onClick={() => navigate("customers")}>
										Add a customer <span className="ml-auto">→</span>
									</button>
								</li>
							)}
							{canView("projects") && (
								<li>
									<button onClick={() => navigate("projects")}>
										Start a project <span className="ml-auto">→</span>
									</button>
								</li>
							)}
							{canView("social") && (
								<li>
									<button onClick={() => navigate("social")}>
										Review social queue <span className="ml-auto">→</span>
									</button>
								</li>
							)}
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}
function Empty({
	title,
	body,
	action,
	onClick,
}: {
	title: string;
	body: string;
	action?: string;
	onClick?: () => void;
}) {
	return (
		<div className="rounded-box border border-dashed border-base-300 bg-base-200/50 p-7 text-center">
			<div className="mx-auto grid size-10 place-items-center rounded-full bg-base-200 text-lg">
				⌁
			</div>
			<h3 className="mt-3 font-semibold">{title}</h3>
			<p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
				{body}
			</p>
			{action && (
				<button className="btn btn-primary btn-sm mt-4" onClick={onClick}>
					{action}
				</button>
			)}
		</div>
	);
}

function Team({
	members,
	canEdit,
	onEdit,
	onAdd,
}: {
	members: Member[];
	canEdit: boolean;
	onEdit: (item: Member) => void;
	onAdd: () => void;
}) {
	return (
		<>
			<PageTitle
				eyebrow="People"
				heading="People who make the work happen"
				description="Roles and module access for this workspace."
				action={
					canEdit && (
						<button className="btn btn-primary" onClick={onAdd}>
							＋ Add member
						</button>
					)
				}
			/>
			{!canEdit && (
				<div className="alert mb-4">
					You can view team details. An administrator manages team access.
				</div>
			)}
			<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
				<table className="table">
					<thead>
						<tr>
							<th>Person</th>
							<th>Role</th>
							<th>Department</th>
							<th>Status</th>
							<th>Access</th>
							{canEdit && (
								<th>
									<span className="sr-only">Actions</span>
								</th>
							)}
						</tr>
					</thead>
					<tbody>
						{members.map((person) => (
							<tr key={person.id}>
								<td>
									<div className="flex items-center gap-3">
										<div className="avatar placeholder">
											<div className="w-10 rounded-full bg-secondary text-secondary-content">
												<span>{initials(person.name)}</span>
											</div>
										</div>
										<span>
											<b className="block">{person.name}</b>
											<span className="text-sm text-base-content/60">
												{person.email}
											</span>
										</span>
									</div>
								</td>
								<td className="capitalize">{person.role}</td>
								<td>{person.department || "—"}</td>
								<td>
									<span
										className={`badge ${person.status === "active" ? "badge-success" : "badge-ghost"}`}
									>
										{person.status === "pending"
											? "Pending setup"
											: person.status}
									</span>
								</td>
								<td>
									<div className="flex max-w-52 flex-wrap gap-1">
										{person.access.map((x) => (
											<span
												className="badge badge-outline badge-sm capitalize"
												key={x}
											>
												{x}
											</span>
										))}
									</div>
								</td>
								{canEdit && (
									<td>
										<button
											className="btn btn-ghost btn-sm"
											onClick={() => onEdit(person)}
										>
											Edit
										</button>
									</td>
								)}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}

function Customers({
	items,
	canEdit,
	onEdit,
	onAdd,
}: {
	items: Customer[];
	canEdit: boolean;
	onEdit: (item: Customer) => void;
	onAdd: () => void;
}) {
	const [search, setSearch] = useState("");
	const filtered = items.filter((item) =>
		`${item.name} ${item.company} ${item.email}`
			.toLowerCase()
			.includes(search.toLowerCase()),
	);
	return (
		<>
			<PageTitle
				eyebrow="Relationships"
				heading="Customers"
				description="Keep the key people and context close to your team’s work."
				action={
					canEdit && (
						<button className="btn btn-primary" onClick={onAdd}>
							＋ Add customer
						</button>
					)
				}
			/>
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<label className="input input-bordered flex w-full max-w-md items-center gap-2 bg-base-100">
					<span aria-hidden="true">⌕</span>
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search customers"
						aria-label="Search customers"
					/>
				</label>
				<span className="text-sm text-base-content/60">
					{filtered.length} {filtered.length === 1 ? "customer" : "customers"}
				</span>
			</div>
			{filtered.length ? (
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
					{filtered.map((item) => (
						<article
							className="card border border-base-300 bg-base-100 shadow-sm"
							key={item.id}
						>
							<div className="card-body">
								<div className="flex items-start justify-between gap-3">
									<div className="flex items-center gap-3">
										<div className="grid size-11 place-items-center rounded-xl bg-secondary/15 font-semibold text-secondary">
											{initials(item.company || item.name)}
										</div>
										<div>
											<h3 className="font-semibold">
												{item.company || item.name}
											</h3>
											<p className="text-sm text-base-content/60">
												{item.name}
											</p>
										</div>
									</div>
									<span
										className={`badge ${item.status === "active" ? "badge-success badge-outline" : "badge-ghost"}`}
									>
										{item.status}
									</span>
								</div>
								<div className="divider my-0" />
								<p className="text-sm text-base-content/70">
									{item.email || "No email recorded"}
								</p>
								<p className="line-clamp-3 min-h-12 text-sm text-base-content/60">
									{item.notes || "No notes yet."}
								</p>
								{canEdit && (
									<div className="card-actions justify-end">
										<button
											className="btn btn-ghost btn-sm"
											onClick={() => onEdit(item)}
										>
											Edit details
										</button>
									</div>
								)}
							</div>
						</article>
					))}
				</div>
			) : (
				<Empty
					title={items.length ? "No matches" : "No customers yet"}
					body={
						items.length
							? "Try a different search."
							: "Add a customer to keep useful context close to the work."
					}
					action={canEdit && !items.length ? "Add a customer" : undefined}
					onClick={onAdd}
				/>
			)}
		</>
	);
}

function Projects({
	items,
	boards,
	tasks,
	customers,
	members,
	currentUser,
	canEdit,
	canReadReports,
	currentUserId,
	onSaveBoard,
	onSaveTask,
	onEdit,
	onAdd,
}: {
	items: Project[];
	boards: Board[];
	tasks: Task[];
	customers: Customer[];
	members: Member[];
	currentUser: Member;
	canEdit: boolean;
	canReadReports: boolean;
	currentUserId: string;
	onSaveBoard: (board: Board) => Promise<unknown>;
	onSaveTask: (task: Task) => Promise<unknown>;
	onEdit: (item: Project) => void;
	onAdd: () => void;
}) {
	const [filter, setFilter] = useState("all");
	const [selectedProjectId, setSelectedProjectId] = useState(
		items[0]?.id || "",
	);
	const [selectedBoardId, setSelectedBoardId] = useState("");
	const [selectedTaskId, setSelectedTaskId] = useState("");
	const [taskSearch, setTaskSearch] = useState("");
	const [ownerFilter, setOwnerFilter] = useState("");
	const [priorityFilter, setPriorityFilter] = useState("");
	const [dragTaskId, setDragTaskId] = useState("");
	const [dropColumn, setDropColumn] = useState("");
	const [moveNotice, setMoveNotice] = useState("");
	const [taskDraft, setTaskDraft] = useState<Task | null>(null);
	const [boardEditor, setBoardEditor] = useState(false);
	const [boardName, setBoardName] = useState("");
	const [boardColumns, setBoardColumns] = useState(
		"Backlog\nIn progress\nReview\nDone",
	);
	const [saveError, setSaveError] = useState("");
	const [saving, setSaving] = useState(false);
	const shown = items.filter((p) => filter === "all" || p.status === filter);
	const filters = ["all", "active", "on_hold", "completed", "archived"];
	const selectedProject =
		shown.find((item) => item.id === selectedProjectId) || shown[0];
	const projectBoards = boards.filter(
		(board) => board.projectId === selectedProject?.id,
	);
	const selectedBoard =
		projectBoards.find((board) => board.id === selectedBoardId) ||
		projectBoards[0];
	const allBoardTasks = tasks.filter(
		(task) => task.boardId === selectedBoard?.id,
	);
	const boardTasks = allBoardTasks.filter(
		(task) =>
			`${task.title} ${task.description}`
				.toLowerCase()
				.includes(taskSearch.toLowerCase()) &&
			(!ownerFilter ||
				(ownerFilter === "unassigned"
					? !task.assigneeId
					: task.assigneeId === ownerFilter)) &&
			(!priorityFilter || task.priority === priorityFilter),
	);
	const selectedTask = tasks.find((task) => task.id === selectedTaskId);
	const moveTask = async (task: Task, column: string) => {
		if (!canEdit || saving || task.column === column) return;
		setSaving(true);
		setSaveError("");
		setMoveNotice(`Moving ${task.title}…`);
		try {
			await onSaveTask({ ...task, column });
			setMoveNotice(`Moved ${task.title} to ${column}.`);
		} catch (error) {
			setSaveError(
				error instanceof Error
					? error.message
					: "Could not move task. Try again.",
			);
			setMoveNotice("");
		} finally {
			setSaving(false);
			setDragTaskId("");
			setDropColumn("");
		}
	};
	const availableOwners = members.some((member) => member.id === currentUserId)
		? members
		: [...members, currentUser];
	const save = async (action: () => Promise<unknown>) => {
		setSaving(true);
		setSaveError("");
		try {
			await action();
			setTaskDraft(null);
			setBoardEditor(false);
		} catch (error) {
			setSaveError(
				error instanceof Error ? error.message : "Could not save this change.",
			);
		} finally {
			setSaving(false);
		}
	};
	const startTask = (
		column = selectedBoard?.columns[0] || "Backlog",
		task?: Task,
	) => {
		setSaveError("");
		setTaskDraft(
			task
				? { ...task }
				: {
						id: "",
						projectId: selectedProject?.id || "",
						boardId: selectedBoard?.id || "",
						column,
						title: "",
						description: "",
						assigneeId: currentUserId,
						priority: "medium",
						dueDate: "",
					},
		);
	};
	return (
		<div className="project-desk">
			<PageTitle
				eyebrow="Work in motion"
				heading="Project desk"
				description="Choose a project, then work through its boards and tasks."
				action={
					canEdit && (
						<button className="btn btn-primary" onClick={onAdd}>
							＋ New project
						</button>
					)
				}
			/>
			<div
				role="group"
				aria-label="Filter projects"
				className="tabs tabs-boxed mb-5 w-fit bg-base-200"
			>
				{filters.map((value) => (
					<button
						key={value}
						role="tab"
						aria-selected={filter === value}
						onClick={() => setFilter(value)}
						className={`tab capitalize ${filter === value ? "tab-active" : ""}`}
					>
						{value === "on_hold" ? "On hold" : value}
					</button>
				))}
			</div>
			{shown.length ? (
				<div className="desk-layout">
					<nav className="project-rail" aria-label="Projects">
						<div className="project-rail-heading">
							<h2>Projects</h2>
							<span>{shown.length}</span>
						</div>
						{shown.map((project) => {
							const customer = customers.find(
								(c) => c.id === project.customerId,
							);
							const count = tasks.filter(
								(task) => task.projectId === project.id,
							).length;
							return (
								<button
									key={project.id}
									className={`project-pick ${selectedProject?.id === project.id ? "is-selected" : ""}`}
									aria-current={
										selectedProject?.id === project.id ? "page" : undefined
									}
									onClick={() => {
										setSelectedProjectId(project.id);
										setSelectedBoardId("");
										setBoardEditor(false);
										setTaskDraft(null);
									}}
								>
									<span className="project-pick-title">{project.name}</span>
									<span className="project-pick-meta">
										{customer?.company || customer?.name || "Internal"}
									</span>
									<span className="project-pick-foot">
										<span className="badge badge-sm badge-outline capitalize">
											{project.status.replace("_", " ")}
										</span>
										<span>{count} tasks</span>
									</span>
								</button>
							);
						})}
					</nav>
					{selectedProject && (
						<section
							className="workbench"
							aria-label={`${selectedProject.name} workspace`}
						>
							<header className="workbench-header">
								<div>
									<div className="flex flex-wrap items-center gap-2">
										<span className="badge badge-outline capitalize">
											{selectedProject.status.replace("_", " ")}
										</span>
										<span className="text-sm text-base-content/60">
											Target {dateText(selectedProject.targetDate)}
										</span>
									</div>
									<h2>{selectedProject.name}</h2>
									<p>{selectedProject.summary || "No project summary yet."}</p>
								</div>
								<div className="workbench-actions">
									{canEdit && (
										<button
											className="btn btn-ghost btn-sm"
											onClick={() => onEdit(selectedProject)}
										>
											Edit project
										</button>
									)}
									{canEdit && selectedBoard && (
										<button
											className="btn btn-primary btn-sm"
											onClick={() => startTask()}
										>
											＋ Add task
										</button>
									)}
								</div>
							</header>
							<div className="workbench-meta">
								<span>
									<small>Customer</small>
									<b>
										{customers.find((c) => c.id === selectedProject.customerId)
											?.company ||
											customers.find((c) => c.id === selectedProject.customerId)
												?.name ||
											"Internal"}
									</b>
								</span>
								<span>
									<small>Project owner</small>
									<b>
										{members.find((m) => m.id === selectedProject.ownerId)
											?.name || "Unassigned"}
									</b>
								</span>
								<span>
									<small>Board tasks</small>
									<b>
										{
											tasks.filter(
												(task) => task.projectId === selectedProject.id,
											).length
										}
									</b>
								</span>
							</div>
							<div className="board-bar">
								<div
									role="tablist"
									aria-label="Project boards"
									className="board-tabs"
								>
									{projectBoards.map((board) => (
										<button
											key={board.id}
											role="tab"
											aria-selected={(selectedBoard?.id || "") === board.id}
											className={`board-tab ${(selectedBoard?.id || "") === board.id ? "is-active" : ""}`}
											onClick={() => {
												setSelectedBoardId(board.id);
												setBoardEditor(false);
												setTaskDraft(null);
											}}
										>
											{board.name}
											<span>
												{
													tasks.filter((task) => task.boardId === board.id)
														.length
												}
											</span>
										</button>
									))}
								</div>
								{canEdit && (
									<button
										className="btn btn-ghost btn-sm"
										onClick={() => {
											setBoardName("");
											setBoardColumns("Backlog\nIn progress\nReview\nDone");
											setBoardEditor((value) => !value);
										}}
									>
										＋ New board
									</button>
								)}
							</div>
							{boardEditor && (
								<form
									className="board-editor"
									onSubmit={(event) => {
										event.preventDefault();
										const columns = boardColumns
											.split("\n")
											.map((column) => column.trim())
											.filter(Boolean);
										if (
											!boardName.trim() ||
											!columns.length ||
											!selectedProject
										)
											return;
										void save(async () => {
											await onSaveBoard({
												id: "",
												projectId: selectedProject.id,
												name: boardName.trim(),
												columns,
											});
										});
									}}
								>
									<label className="form-control">
										<span className="label-text mb-1">Board name</span>
										<input
											className="input input-bordered input-sm"
											value={boardName}
											onChange={(event) => setBoardName(event.target.value)}
											required
										/>
									</label>
									<label className="form-control">
										<span className="label-text mb-1">
											Columns, one per line
										</span>
										<textarea
											className="textarea textarea-bordered"
											value={boardColumns}
											onChange={(event) => setBoardColumns(event.target.value)}
											required
											rows={4}
										/>
									</label>
									<div className="flex gap-2">
										<button
											className="btn btn-primary btn-sm"
											disabled={saving}
										>
											Create board
										</button>
										<button
											type="button"
											className="btn btn-ghost btn-sm"
											onClick={() => setBoardEditor(false)}
										>
											Cancel
										</button>
									</div>
								</form>
							)}
							{saveError && (
								<div role="alert" className="alert alert-error mt-4">
									{saveError}
								</div>
							)}
							{!projectBoards.length && (
								<div className="empty-board">
									<h3>No board for this project</h3>
									<p>
										Boards give the project a clear path from backlog to done.
									</p>
									{canEdit && (
										<button
											className="btn btn-primary btn-sm"
											onClick={() => setBoardEditor(true)}
										>
											Create a board
										</button>
									)}
								</div>
							)}
							{selectedBoard && (
								<div
									className="board-task-filters"
									aria-label="Filter board tasks"
								>
									<label className="form-control">
										<span className="label-text mb-1">Search tasks</span>
										<input
											className="input input-bordered input-sm"
											value={taskSearch}
											onChange={(event) => setTaskSearch(event.target.value)}
											placeholder="Title or description"
										/>
									</label>
									<div className="form-control">
										<label
											className="label-text mb-1"
											htmlFor="board-filter-owner"
										>
											Owner
										</label>
										<select
											id="board-filter-owner"
											className="select select-bordered select-sm"
											value={ownerFilter}
											onChange={(event) => setOwnerFilter(event.target.value)}
										>
											<option value="">All owners</option>
											<option value="unassigned">Unassigned</option>
											{availableOwners.map((member) => (
												<option key={member.id} value={member.id}>
													{member.name}
												</option>
											))}
										</select>
									</div>
									<div className="form-control">
										<label
											className="label-text mb-1"
											htmlFor="board-filter-priority"
										>
											Priority
										</label>
										<select
											id="board-filter-priority"
											className="select select-bordered select-sm"
											value={priorityFilter}
											onChange={(event) =>
												setPriorityFilter(event.target.value)
											}
										>
											<option value="">All priorities</option>
											{["low", "medium", "high", "urgent"].map((value) => (
												<option key={value}>{value}</option>
											))}
										</select>
									</div>
									<span className="text-sm text-base-content/65">
										{boardTasks.length} of {allBoardTasks.length} tasks
									</span>
									{(taskSearch || ownerFilter || priorityFilter) && (
										<button
											className="btn btn-ghost btn-sm"
											onClick={() => {
												setTaskSearch("");
												setOwnerFilter("");
												setPriorityFilter("");
											}}
										>
											Clear filters
										</button>
									)}
								</div>
							)}
							<p role="status" className="board-move-status">
								{moveNotice}
							</p>
							{selectedBoard && (
								<div className="board-columns">
									{selectedBoard.columns.map((column) => {
										const columnTasks = boardTasks.filter(
											(task) => task.column === column,
										);
										return (
											<section
												className={`board-column ${dropColumn === column ? "is-drop-target" : ""}`}
												onDragOver={(event) => {
													if (canEdit && dragTaskId && !saving) {
														event.preventDefault();
														event.dataTransfer.dropEffect = "move";
														setDropColumn(column);
													}
												}}
												onDragLeave={(event) => {
													if (
														!event.currentTarget.contains(
															event.relatedTarget as Node,
														)
													)
														setDropColumn("");
												}}
												onDrop={(event) => {
													event.preventDefault();
													const task = allBoardTasks.find(
														(task) => task.id === dragTaskId,
													);
													if (task) void moveTask(task, column);
												}}
												key={`${selectedBoard.id}-${column}`}
												aria-label={`${column}, ${columnTasks.length} tasks`}
											>
												<div className="column-heading">
													<h3>{column}</h3>
													<span>{columnTasks.length}</span>
												</div>
												<div className="column-tasks">
													{columnTasks.map((task) => {
														const owner = availableOwners.find(
															(member) => member.id === task.assigneeId,
														);
														return (
															<article
																className={`task-row ${dragTaskId === task.id ? "is-dragging" : ""}`}
																key={task.id}
																draggable={canEdit && !saving}
																aria-busy={saving}
																onDragStart={(event) => {
																	if (
																		(event.target as HTMLElement).closest(
																			"select",
																		)
																	) {
																		event.preventDefault();
																		return;
																	}
																	setDragTaskId(task.id);
																	event.dataTransfer.effectAllowed = "move";
																	event.dataTransfer.setData(
																		"text/plain",
																		task.id,
																	);
																}}
																onDragEnd={() => {
																	setDragTaskId("");
																	setDropColumn("");
																}}
															>
																<button
																	className="task-main"
																	onClick={() => setSelectedTaskId(task.id)}
																	aria-label={`Open task: ${task.title}`}
																>
																	<span className="task-title">
																		{task.title}
																	</span>
																	{task.description && (
																		<span className="task-description">
																			{task.description}
																		</span>
																	)}
																	<span className="task-detail">
																		<span
																			className={`priority priority-${task.priority}`}
																		>
																			{task.priority}
																		</span>
																		<span>
																			{owner?.name ||
																				(task.assigneeId
																					? "Assigned teammate"
																					: "Unassigned")}
																		</span>
																	</span>
																	<span className="task-due">
																		Due {dateText(task.dueDate)}
																		<span className="task-comment-count">
																			{task.commentCount ?? 0} comments
																		</span>
																	</span>
																</button>
																{canEdit &&
																	selectedBoard.columns.length > 1 && (
																		<label
																			className="sr-only"
																			htmlFor={`move-${task.id}`}
																		>
																			Move {task.title} to column
																		</label>
																	)}
																{canEdit &&
																	selectedBoard.columns.length > 1 && (
																		<select
																			id={`move-${task.id}`}
																			className="select select-bordered select-xs task-move"
																			aria-label={`Move ${task.title} to column`}
																			value={column}
																			disabled={saving}
																			onChange={(event) =>
																				void moveTask(task, event.target.value)
																			}
																		>
																			{selectedBoard.columns.map((option) => (
																				<option key={option}>{option}</option>
																			))}
																		</select>
																	)}
															</article>
														);
													})}
												</div>
												{canEdit && (
													<button
														className="add-task-link"
														onClick={() => startTask(column)}
													>
														＋ Add task
													</button>
												)}
											</section>
										);
									})}
								</div>
							)}
							{!projectBoards.length &&
								items.length > 0 &&
								boards.length === 0 && (
									<p className="text-sm text-base-content/60">
										Boards are loaded from the workspace service.
									</p>
								)}
						</section>
					)}
				</div>
			) : (
				<Empty
					title={items.length ? "Nothing in this view" : "No projects yet"}
					body={
						items.length
							? "Choose a different status to see other work."
							: "Start a project to give your next piece of work a home."
					}
					action={canEdit && !items.length ? "New project" : undefined}
					onClick={onAdd}
				/>
			)}
			{selectedTask && (
				<TaskDetails
					key={selectedTask.id}
					task={selectedTask}
					members={availableOwners}
					columns={
						boards.find((board) => board.id === selectedTask.boardId)
							?.columns || []
					}
					currentUser={currentUser}
					canEdit={canEdit}
					canReadReports={canReadReports}
					projectName={
						items.find((project) => project.id === selectedTask.projectId)
							?.name || "Project"
					}
					boardName={
						boards.find((board) => board.id === selectedTask.boardId)?.name ||
						"Board"
					}
					onClose={() => setSelectedTaskId("")}
					onSave={onSaveTask}
				/>
			)}
			{taskDraft && (
				<TaskEditor
					task={taskDraft}
					members={availableOwners}
					columns={selectedBoard?.columns || ["Backlog"]}
					busy={saving}
					error={saveError}
					onClose={() => {
						setTaskDraft(null);
						setSaveError("");
					}}
					onSave={(task) => void save(() => onSaveTask(task))}
				/>
			)}
		</div>
	);
}

function TaskEditor({
	task,
	members,
	columns,
	busy,
	error,
	onClose,
	onSave,
}: {
	task: Task;
	members: Member[];
	columns: string[];
	busy: boolean;
	error: string;
	onClose: () => void;
	onSave: (task: Task) => void;
}) {
	const [value, setValue] = useState(task);
	const fieldId = useId();
	return (
		<div
			className="modal modal-open"
			role="dialog"
			aria-modal="true"
			aria-labelledby="task-editor-title"
		>
			<div className="modal-box max-w-xl">
				<h2 id="task-editor-title" className="text-xl font-semibold">
					{task.id ? "Edit task" : "Add task"}
				</h2>
				<form
					className="mt-5 grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						onSave(value);
					}}
				>
					{error && (
						<div role="alert" className="alert alert-error">
							{error}
						</div>
					)}
					<label className="form-control">
						<span className="label-text mb-1">Task title</span>
						<input
							autoFocus
							className="input input-bordered"
							value={value.title}
							onChange={(event) =>
								setValue({ ...value, title: event.target.value })
							}
							required
						/>
					</label>
					<label className="form-control">
						<span className="label-text mb-1">Description</span>
						<textarea
							className="textarea textarea-bordered"
							value={value.description}
							onChange={(event) =>
								setValue({ ...value, description: event.target.value })
							}
							rows={3}
						/>
					</label>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="form-control">
							<label className="label-text mb-1" htmlFor={`${fieldId}-owner`}>
								Owner
							</label>
							<select
								id={`${fieldId}-owner`}
								className="select select-bordered"
								value={value.assigneeId}
								onChange={(event) =>
									setValue({ ...value, assigneeId: event.target.value })
								}
							>
								<option value="">Unassigned</option>
								{members
									.filter((member) => member.status === "active")
									.map((member) => (
										<option key={member.id} value={member.id}>
											{member.name}
										</option>
									))}
							</select>
						</div>
						<div className="form-control">
							<label
								className="label-text mb-1"
								htmlFor={`${fieldId}-priority`}
							>
								Priority
							</label>
							<select
								id={`${fieldId}-priority`}
								className="select select-bordered"
								value={value.priority}
								onChange={(event) =>
									setValue({ ...value, priority: event.target.value })
								}
							>
								{["low", "medium", "high", "urgent"].map((priority) => (
									<option key={priority} value={priority}>
										{priority}
									</option>
								))}
							</select>
						</div>
						<div className="form-control">
							<label className="label-text mb-1" htmlFor={`${fieldId}-column`}>
								Column
							</label>
							<select
								id={`${fieldId}-column`}
								className="select select-bordered"
								value={value.column}
								onChange={(event) =>
									setValue({ ...value, column: event.target.value })
								}
							>
								{columns.map((column) => (
									<option key={column}>{column}</option>
								))}
							</select>
						</div>
						<label className="form-control">
							<span className="label-text mb-1">Due date</span>
							<input
								type="date"
								className="input input-bordered"
								value={value.dueDate}
								onChange={(event) =>
									setValue({ ...value, dueDate: event.target.value })
								}
							/>
						</label>
					</div>
					<div className="modal-action">
						<button type="button" className="btn btn-ghost" onClick={onClose}>
							Cancel
						</button>
						<button className="btn btn-primary" disabled={busy}>
							{busy && <span className="loading loading-spinner loading-sm" />}
							{task.id ? "Save task" : "Create task"}
						</button>
					</div>
				</form>
			</div>
			<button
				className="modal-backdrop"
				onClick={onClose}
				aria-label="Close task editor"
			>
				Close
			</button>
		</div>
	);
}

function Social({
	items,
	connections,
	demoMode,
	persistentStorage,
	canEdit,
	onEdit,
	onAdd,
}: {
	items: ScheduledPost[];
	connections: Workspace["connections"];
	demoMode: boolean;
	persistentStorage: boolean;
	canEdit: boolean;
	onEdit: (item: ScheduledPost) => void;
	onAdd: () => void;
}) {
	const [filter, setFilter] = useState("all");
	const shown = items.filter(
		(post) => filter === "all" || post.status === filter,
	);
	return (
		<>
			<div
				className={`alert mb-5 border text-sm ${persistentStorage ? "border-info/20 bg-info/10" : "border-warning/20 bg-warning/10"}`}
			>
				<span>ⓘ</span>
				<span>
					{demoMode
						? "Channels and scheduled times are sample records. Posts are never published from this workspace."
						: "The queue contains office records. Social posting is not available yet."}{" "}
					{persistentStorage
						? "Changes are saved in SQLite."
						: "Changes reset when the server restarts."}
				</span>
			</div>
			<PageTitle
				eyebrow="Content planning"
				heading="Social queue"
				description="Plan content and keep review status clear. Nothing here is published."
				action={
					canEdit &&
					connections.length > 0 && (
						<button className="btn btn-primary" onClick={onAdd}>
							＋ Compose post
						</button>
					)
				}
			/>
			<section className="card mb-5 border border-base-300 bg-base-100 shadow-sm">
				<div className="card-body">
					<h2 className="font-semibold">
						{demoMode ? "Demo channels" : "Social channels"}
					</h2>
					<p className="text-sm text-base-content/60">
						{demoMode
							? "These entries illustrate the queue. Connecting accounts is not available."
							: connections.length > 0
								? "Social account connections and posting are not available yet."
								: "No social channels are connected yet. Account connections are not available."}
					</p>
					<div className="mt-2 flex flex-wrap gap-2">
						{connections.map((connection) => (
							<span
								key={connection.id}
								className="badge badge-lg badge-outline gap-2"
							>
								{connection.platform}
								<span
									className={`badge badge-sm ${connection.demo ? "badge-info" : "badge-ghost"}`}
								>
									{connection.demo ? "Demo channel" : connection.status}
								</span>
							</span>
						))}
					</div>
				</div>
			</section>
			<div role="tablist" className="tabs tabs-boxed mb-5 w-fit bg-base-200">
				{["all", "draft", "queued", "needs_review"].map((value) => (
					<button
						key={value}
						role="tab"
						aria-selected={filter === value}
						className={`tab capitalize ${filter === value ? "tab-active" : ""}`}
						onClick={() => setFilter(value)}
					>
						{value.replace("_", " ")}
					</button>
				))}
			</div>
			{shown.length ? (
				<div className="grid gap-4 lg:grid-cols-2">
					{shown.map((post) => {
						const channel = connections.find((c) => c.id === post.connectionId);
						return (
							<article
								key={post.id}
								className="card border border-base-300 bg-base-100 shadow-sm"
							>
								<div className="card-body">
									<div className="flex items-center justify-between gap-2">
										<span className="badge badge-outline">
											{channel?.platform || "Unassigned channel"}
										</span>
										<span
											className={`badge ${post.status === "queued" ? "badge-success" : post.status === "needs_review" ? "badge-warning" : "badge-ghost"}`}
										>
											{post.status.replace("_", " ")}
										</span>
									</div>
									<p className="whitespace-pre-wrap text-sm leading-relaxed">
										{post.content}
									</p>
									<div className="flex items-center justify-between border-t border-base-200 pt-3 text-sm text-base-content/60">
										<span>
											{post.status === "draft"
												? "No schedule"
												: dateText(post.scheduledAt)}
										</span>
										{canEdit && (
											<button
												className="btn btn-ghost btn-sm"
												onClick={() => onEdit(post)}
											>
												Edit
											</button>
										)}
									</div>
								</div>
							</article>
						);
					})}
				</div>
			) : (
				<Empty
					title="Nothing in the queue"
					body={
						connections.length === 0
							? "Connect a social channel before composing a post."
							: demoMode
								? "Draft a post to plan content for your team. The demo does not publish posts."
								: "Draft a post to plan content for your team. Social posting is not available yet."
					}
					action={
						canEdit && connections.length > 0 ? "Compose post" : undefined
					}
					onClick={onAdd}
				/>
			)}
		</>
	);
}

function Settings({
	data,
	demoMode,
	persistentStorage,
	canManage,
	theme,
	onTheme,
	onSave,
	secretToReveal,
	onSecret,
}: {
	data: Workspace;
	demoMode: boolean;
	persistentStorage: boolean;
	canManage: boolean;
	theme: string;
	onTheme: (theme: string) => void;
	onSave: (settings: Workspace["settings"]) => void;
	secretToReveal: string;
	onSecret: (secret: string) => void;
}) {
	const [workspaceName, setWorkspaceName] = useState(
		data.settings.workspaceName,
	);
	const [timezone, setTimezone] = useState(data.settings.timezone);
	const [keyName, setKeyName] = useState("");
	const [keyScopes, setKeyScopes] = useState<string[]>(["projects:read"]);
	const [keyExpiry, setKeyExpiry] = useState(90);
	const [keyError, setKeyError] = useState("");
	const [copyError, setCopyError] = useState("");
	const fieldId = useId();
	const queryClient = useQueryClient();
	const keysQuery = useQuery({
		queryKey: ["agent-keys"],
		queryFn: listAgentKeys,
		enabled: canManage,
		retry: false,
	});
	const createKeyMutation = useMutation({
		mutationFn: async (input: {
			name: string;
			scopes: string[];
			expiresInDays: number;
		}) => {
			const result = await createAgentKey(input);
			onSecret(result.secret);
			return result.key;
		},
		onSuccess: () => {
			setKeyName("");
			void queryClient.invalidateQueries({ queryKey: ["agent-keys"] });
		},
		onError: (error) => setKeyError(error.message),
	});
	const revokeKeyMutation = useMutation({
		mutationFn: revokeAgentKey,
		onSuccess: () =>
			void queryClient.invalidateQueries({ queryKey: ["agent-keys"] }),
		onError: (error) => setKeyError(error.message),
	});
	const zones = useMemo(
		() => [
			...new Set([
				"UTC",
				Intl.DateTimeFormat().resolvedOptions().timeZone,
				"Asia/Kolkata",
				"America/New_York",
				"Europe/London",
			]),
		],
		[],
	);
	return (
		<div className="grid gap-5">
			<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.7fr)]">
				<section className="card border border-base-300 bg-base-100 shadow-sm">
					<div className="card-body">
						<PageTitle
							eyebrow="Workspace preferences"
							heading="Settings"
							description="Choose how your shared office looks and reads."
						/>
						<form
							className="grid gap-5"
							onSubmit={(e) => {
								e.preventDefault();
								onSave({
									...data.settings,
									workspaceName,
									timezone,
									defaultTheme: theme,
								});
							}}
						>
							<label className="form-control">
								<span className="label-text mb-2 font-medium">
									Workspace name
								</span>
								<input
									className="input input-bordered"
									value={workspaceName}
									onChange={(e) => setWorkspaceName(e.target.value)}
									disabled={!canManage}
								/>
							</label>
							<div className="form-control">
								<label
									className="label-text mb-2 font-medium"
									htmlFor={`${fieldId}-timezone`}
								>
									Timezone
								</label>
								<select
									id={`${fieldId}-timezone`}
									className="select select-bordered"
									value={timezone}
									onChange={(e) => setTimezone(e.target.value)}
									disabled={!canManage}
								>
									{zones.map((zone) => (
										<option key={zone}>{zone}</option>
									))}
								</select>
							</div>
							<div className="form-control">
								<label
									className="label-text mb-2 font-medium"
									htmlFor={`${fieldId}-theme`}
								>
									Color theme
								</label>
								<select
									id={`${fieldId}-theme`}
									className="select select-bordered"
									aria-describedby={`${fieldId}-theme-help`}
									value={theme}
									onChange={(e) => onTheme(e.target.value)}
								>
									{themes.map((item) => (
										<option key={item} value={item}>
											{item.replace(/([a-z])([A-Z])/g, "$1 $2")}
										</option>
									))}
								</select>
								<span
									id={`${fieldId}-theme-help`}
									className="label-text-alt mt-1"
								>
									Your theme applies in this browser. The workspace default is
									saved by an administrator.
								</span>
							</div>
							{canManage && (
								<div className="card-actions justify-end">
									<button className="btn btn-primary">
										Save workspace settings
									</button>
								</div>
							)}
						</form>
						{!canManage && (
							<p className="text-sm text-base-content/60">
								Only an administrator can change workspace name and timezone.
							</p>
						)}
					</div>
				</section>
				<section className="card border border-base-300 bg-base-100 shadow-sm">
					<div className="card-body">
						<p className="text-sm font-semibold uppercase tracking-wider text-base-content/50">
							Your profile
						</p>
						<h2 className="text-xl font-semibold">{data.currentUser.name}</h2>
						<div className="grid gap-1 text-sm text-base-content/65">
							<span>{data.currentUser.email}</span>
							<span>
								{data.currentUser.jobTitle} · {data.currentUser.department}
							</span>
						</div>
						<div className="divider" />
						<span className="badge badge-primary badge-outline w-fit capitalize">
							{data.currentUser.role}
						</span>
						<p className="text-sm text-base-content/65">
							Your access:{" "}
							{data.currentUser.role === "admin"
								? "All modules"
								: data.currentUser.access.join(", ") || "No business modules"}
						</p>
						<div
							className={`alert mt-2 border text-sm ${persistentStorage ? "border-info/20 bg-info/10" : "border-warning/20 bg-warning/10"}`}
						>
							<span>ⓘ</span>
							<span>
								{demoMode
									? "This workspace includes sample records."
									: "This workspace contains office records."}{" "}
								{persistentStorage
									? "Changes are saved in SQLite and persist across server restarts."
									: "Changes reset when the server restarts."}
							</span>
						</div>
					</div>
				</section>
			</div>
			{canManage && (
				<section className="card border border-base-300 bg-base-100 shadow-sm">
					<div className="card-body">
						<PageTitle
							eyebrow="Agent access"
							heading="AI access keys"
							description="Create scoped keys for agents that use the Office Office RPC interface."
						/>
						<div
							className={`alert border text-sm ${persistentStorage ? "border-info/20 bg-info/10" : "border-warning/20 bg-warning/10"}`}
						>
							<span>ⓘ</span>
							<span>
								{!persistentStorage ? (
									<>
										Keys work with the <code>/mcp</code> endpoint. Key metadata
										resets when the server restarts.
									</>
								) : (
									<>
										Keys work with the <code>/mcp</code> endpoint. Key metadata
										is saved in SQLite.
									</>
								)}
							</span>
						</div>
						{keyError && (
							<div role="alert" className="alert alert-error">
								{keyError}
								<button
									className="btn btn-ghost btn-xs"
									onClick={() => setKeyError("")}
								>
									Dismiss
								</button>
							</div>
						)}
						<form
							className="key-create-form"
							onSubmit={(event) => {
								event.preventDefault();
								setKeyError("");
								createKeyMutation.mutate({
									name: keyName.trim(),
									scopes: keyScopes,
									expiresInDays: keyExpiry,
								});
							}}
						>
							<label className="form-control">
								<span className="label-text mb-1">Key name</span>
								<input
									className="input input-bordered"
									value={keyName}
									onChange={(event) => setKeyName(event.target.value)}
									placeholder="e.g. Reporting assistant"
									required
									maxLength={80}
								/>
							</label>
							<fieldset className="form-control">
								<legend className="label-text mb-2 font-medium">
									Allowed access
								</legend>
								<div className="scope-list">
									{[
										"projects:read",
										"projects:write",
										"customers:read",
										"customers:write",
										"social:read",
										"social:write",
										"reports:read",
										"reports:write",
									].map((scope) => (
										<label
											className="label cursor-pointer justify-start gap-2"
											key={scope}
										>
											<input
												type="checkbox"
												className="checkbox checkbox-sm"
												checked={keyScopes.includes(scope)}
												onChange={(event) =>
													setKeyScopes((current) =>
														event.target.checked
															? [...current, scope]
															: current.filter((item) => item !== scope),
													)
												}
											/>
											<span>{scope}</span>
										</label>
									))}
								</div>
							</fieldset>
							<div className="form-control">
								<label
									className="label-text mb-1"
									htmlFor={`${fieldId}-key-expiry`}
								>
									Expires after
								</label>
								<select
									id={`${fieldId}-key-expiry`}
									className="select select-bordered"
									value={keyExpiry}
									onChange={(event) => setKeyExpiry(Number(event.target.value))}
								>
									<option value={7}>7 days</option>
									<option value={30}>30 days</option>
									<option value={90}>90 days</option>
								</select>
							</div>
							<div className="flex items-end">
								<button
									className="btn btn-primary"
									disabled={createKeyMutation.isPending || !keyScopes.length}
								>
									{createKeyMutation.isPending && (
										<span className="loading loading-spinner loading-sm" />
									)}
									Create key
								</button>
							</div>
						</form>
						{keysQuery.isPending && (
							<div className="py-4">
								<span
									className="loading loading-spinner loading-sm"
									aria-label="Loading keys"
								/>
							</div>
						)}
						{keysQuery.isError && (
							<div role="alert" className="alert alert-error">
								Could not load agent keys: {keysQuery.error.message}
							</div>
						)}
						{keysQuery.data && (
							<div className="key-list">
								<h3>Existing keys</h3>
								{keysQuery.data.keys.length === 0 ? (
									<p className="text-sm text-base-content/60">
										No agent keys have been created.
									</p>
								) : (
									keysQuery.data.keys.map((key) => (
										<article className="key-row" key={key.id}>
											<div>
												<b>{key.name}</b>
												<p>{key.scopes.join(", ") || "No access"}</p>
												<small>
													{key.revoked
														? "Revoked"
														: `Expires ${new Date(Number(key.expiresAt) * 1000).toLocaleDateString()}`}
												</small>
											</div>
											{!key.revoked && (
												<button
													className="btn btn-outline btn-error btn-sm"
													disabled={revokeKeyMutation.isPending}
													onClick={() => revokeKeyMutation.mutate(key.id)}
												>
													Revoke
												</button>
											)}
										</article>
									))
								)}
							</div>
						)}
					</div>
				</section>
			)}
			{secretToReveal && (
				<div
					className="modal modal-open"
					role="dialog"
					aria-modal="true"
					aria-labelledby="created-key-title"
				>
					<div className="modal-box max-w-2xl">
						<h2 id="created-key-title" className="text-xl font-semibold">
							Copy your new key
						</h2>
						<p className="mt-2 text-sm text-base-content/70">
							This secret is shown once. Store it in your agent’s secret manager
							before closing this window.
						</p>
						<div className="secret-field">
							<code>{secretToReveal}</code>
							<button
								className="btn btn-secondary btn-sm"
								onClick={async () => {
									setCopyError("");
									try {
										await navigator.clipboard.writeText(secretToReveal);
									} catch {
										setCopyError(
											"Clipboard access failed. Select and copy the key above.",
										);
									}
								}}
							>
								Copy key
							</button>
						</div>
						{copyError && (
							<p role="alert" className="mt-2 text-sm text-error">
								{copyError}
							</p>
						)}
						<div className="alert mt-4 border border-info/20 bg-info/10 text-sm">
							<span>⌁</span>
							<span>
								Connect to <code>/mcp</code> with this key as a Bearer token. Do
								not put it in browser storage or source control.
							</span>
						</div>
						<div className="modal-action">
							<button
								className="btn btn-primary"
								onClick={() => {
									setCopyError("");
									onSecret("");
								}}
							>
								Done
							</button>
						</div>
					</div>
					<button
						className="modal-backdrop"
						onClick={() => {
							setCopyError("");
							onSecret("");
						}}
						aria-label="Close key dialog"
					>
						Close
					</button>
				</div>
			)}
		</div>
	);
}

function RecordDialog({
	kind,
	initial,
	data,
	busy,
	error,
	onClose,
	onSubmit,
}: {
	kind: "member" | "customer" | "project" | "post";
	initial: Record<string, unknown> | null;
	data: Workspace;
	busy: boolean;
	error?: string;
	onClose: () => void;
	onSubmit: (value: RecordDraft) => void;
}) {
	const [formError, setFormError] = useState("");
	const fieldId = useId();
	const isEdit = Boolean(initial);
	const readString = (key: keyof RecordDraft, fallback = "") => {
		const candidate = initial?.[key];
		return typeof candidate === "string" ? candidate : fallback;
	};
	const [values, setValues] = useState<RecordDraft>(() => ({
		id: readString("id"),
		name: readString("name"),
		email: readString("email"),
		company: readString("company"),
		status: readString("status", kind === "post" ? "draft" : "active"),
		ownerId: readString("ownerId", data.currentUser.id),
		notes: readString("notes"),
		jobTitle: readString("jobTitle"),
		department: readString("department"),
		role: readString("role", "member"),
		access: Array.isArray(initial?.access)
			? initial.access.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: ["customers", "projects", "reports"],
		password: "",
		customerId: readString("customerId"),
		summary: readString("summary"),
		targetDate: readString("targetDate"),
		connectionId: readString("connectionId", data.connections[0]?.id || ""),
		content: readString("content"),
		scheduledAt: readString("scheduledAt").slice(0, 16),
		authorId: readString("authorId", data.currentUser.id),
	}));
	type TextField = Exclude<keyof RecordDraft, "id" | "access" | "password">;
	type FieldConfig = {
		name: TextField;
		label: string;
		type?: string;
		options?: Array<[string, string]>;
		textarea?: boolean;
	};
	const memberFields: FieldConfig[] = [
		{ name: "name", label: "Name" },
		{ name: "email", label: "Email", type: "email" },
		{ name: "jobTitle", label: "Job title" },
		{ name: "department", label: "Department" },
		{
			name: "role",
			label: "Role",
			options: [
				["admin", "Administrator"],
				["manager", "Manager"],
				["member", "Member"],
				["viewer", "Viewer"],
			],
		},
		{
			name: "status",
			label: "Status",
			options: [
				["active", "Active"],
				["inactive", "Inactive"],
				["pending", "Pending setup"],
			],
		},
	];
	const customerFields: FieldConfig[] = [
		{ name: "name", label: "Contact name" },
		{ name: "company", label: "Company" },
		{ name: "email", label: "Email", type: "email" },
		{
			name: "status",
			label: "Status",
			options: [
				["active", "Active"],
				["inactive", "Inactive"],
			],
		},
		{
			name: "ownerId",
			label: "Owner",
			options: data.members.map((member): [string, string] => [
				member.id,
				member.name,
			]),
		},
		{ name: "notes", label: "Notes and context", textarea: true },
	];
	const projectFields: FieldConfig[] = [
		{ name: "name", label: "Project name" },
		{
			name: "customerId",
			label: "Customer",
			options: [
				["", "Internal project"],
				...data.customers.map((customer): [string, string] => [
					customer.id,
					customer.company || customer.name,
				]),
			],
		},
		{
			name: "ownerId",
			label: "Owner",
			options: [
				["", "Unassigned"],
				...data.members.map((member): [string, string] => [
					member.id,
					member.name,
				]),
			],
		},
		{
			name: "status",
			label: "Status",
			options: [
				["active", "Active"],
				["on_hold", "On hold"],
				["completed", "Completed"],
				["archived", "Archived"],
			],
		},
		{ name: "summary", label: "Project summary", textarea: true },
		{ name: "targetDate", label: "Target date", type: "date" },
	];
	const postFields: FieldConfig[] = [
		{
			name: "connectionId",
			label: "Channel",
			options: data.connections.map((connection): [string, string] => [
				connection.id,
				connection.platform,
			]),
		},
		{ name: "content", label: "Post content", textarea: true },
		{ name: "scheduledAt", label: "Scheduled time", type: "datetime-local" },
		{
			name: "status",
			label: "Status",
			options: [
				["draft", "Draft"],
				["queued", "Queued"],
				["needs_review", "Needs review"],
			],
		},
	];
	const fields =
		kind === "member"
			? memberFields
			: kind === "customer"
				? customerFields
				: kind === "project"
					? projectFields
					: postFields;
	const labels = {
		member: "team member",
		customer: "customer",
		project: "project",
		post: "post",
	};
	function update(name: TextField, value: string) {
		setValues((current) => ({ ...current, [name]: value }));
	}
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const requiredValue = kind === "post" ? values.content : values.name;
		const required = v.safeParse(
			v.pipe(v.string(), v.trim(), v.minLength(1)),
			requiredValue,
		);
		if (!required.success) {
			setFormError(kind === "post" ? "Add some post content." : "Add a name.");
			return;
		}
		if (
			values.email.trim() &&
			!v.safeParse(v.pipe(v.string(), v.email()), values.email).success
		) {
			setFormError("Enter a valid email address.");
			return;
		}
		if (kind === "member" && values.password && values.password.length < 12) {
			setFormError("Use at least 12 characters for a temporary password.");
			return;
		}
		setFormError("");
		onSubmit({
			...values,
			id: isEdit ? values.id : "",
			scheduledAt:
				kind === "post" && values.scheduledAt
					? new Date(values.scheduledAt).toISOString()
					: values.scheduledAt,
		});
	}
	return (
		<div
			className="modal modal-open"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !busy) onClose();
			}}
		>
			<section
				className="modal-box max-h-[90vh] max-w-2xl overflow-y-auto"
				role="dialog"
				aria-modal="true"
				aria-labelledby="record-title"
			>
				<div className="flex items-start justify-between">
					<div>
						<p className="text-sm font-semibold uppercase tracking-wider text-base-content/50">
							{isEdit ? "Update record" : "New record"}
						</p>
						<h2 className="mt-1 text-2xl font-semibold" id="record-title">
							{isEdit ? "Edit " : "Add "}
							{labels[kind]}
						</h2>
					</div>
					<button
						className="btn btn-circle btn-ghost btn-sm"
						aria-label="Close dialog"
						onClick={onClose}
						disabled={busy}
					>
						×
					</button>
				</div>
				<p className="mt-2 text-sm text-base-content/60">
					{kind === "member"
						? "Adding someone records them here; it does not send an invitation."
						: kind === "post"
							? "This saves a queue record only. It will not publish to a channel."
							: "Save changes to the shared workspace."}
				</p>
				{(formError || error) && (
					<div role="alert" className="alert alert-error mt-4">
						{formError || error}
					</div>
				)}
				<form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
					{fields.map((field) => (
						<div
							key={field.name}
							className={`form-control ${field.textarea ? "sm:col-span-2" : ""}`}
						>
							<label
								className="label-text mb-2 font-medium"
								htmlFor={`${fieldId}-${field.name}`}
							>
								{field.label}
							</label>
							{field.options ? (
								<select
									id={`${fieldId}-${field.name}`}
									className="select select-bordered"
									value={values[field.name]}
									onChange={(event) => update(field.name, event.target.value)}
								>
									{field.options.map(([value, label]) => (
										<option key={value} value={value}>
											{label}
										</option>
									))}
								</select>
							) : field.textarea ? (
								<textarea
									id={`${fieldId}-${field.name}`}
									className="textarea textarea-bordered min-h-28"
									value={values[field.name]}
									onChange={(event) => update(field.name, event.target.value)}
								/>
							) : (
								<input
									id={`${fieldId}-${field.name}`}
									className="input input-bordered"
									type={field.type || "text"}
									value={values[field.name]}
									onChange={(event) => update(field.name, event.target.value)}
								/>
							)}
						</div>
					))}
					{kind === "member" && (
						<fieldset className="sm:col-span-2">
							<legend className="label-text mb-2 font-medium">
								Module access
							</legend>
							<p className="mb-3 text-sm text-base-content/65">
								Role limits apply: administrators have full access; viewers can
								only read selected modules.
							</p>
							<div className="flex flex-wrap gap-3">
								{[
									"team",
									"customers",
									"projects",
									"reports",
									"social",
									"settings",
								].map((module) => (
									<label className="label cursor-pointer gap-2" key={module}>
										<input
											className="checkbox checkbox-primary checkbox-sm"
											type="checkbox"
											checked={values.access.includes(module)}
											onChange={() =>
												setValues((current) => ({
													...current,
													access: current.access.includes(module)
														? current.access.filter((item) => item !== module)
														: [...current.access, module],
												}))
											}
										/>
										<span className="label-text capitalize">{module}</span>
									</label>
								))}
							</div>
						</fieldset>
					)}
					{kind === "member" && (
						<label className="form-control sm:col-span-2">
							<span className="label-text mb-2 font-medium">
								Temporary password{" "}
								<span className="font-normal text-base-content/55">
									(optional, at least 12 characters)
								</span>
							</span>
							<input
								className="input input-bordered"
								type="password"
								autoComplete="new-password"
								value={values.password}
								onChange={(event) =>
									setValues((current) => ({
										...current,
										password: event.target.value,
									}))
								}
							/>
						</label>
					)}
					<div className="modal-action sm:col-span-2">
						<button
							type="button"
							className="btn btn-ghost"
							onClick={onClose}
							disabled={busy}
						>
							Cancel
						</button>
						<button className="btn btn-primary" disabled={busy}>
							{busy && <span className="loading loading-spinner loading-sm" />}
							{isEdit ? "Save changes" : `Add ${labels[kind]}`}
						</button>
					</div>
				</form>
			</section>
		</div>
	);
}
