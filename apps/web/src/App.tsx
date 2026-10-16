import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatches, useNavigate } from "@tanstack/react-router";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useState,
} from "react";
import * as v from "valibot";
import {
	type Board,
	bootstrapAdmin,
	type Customer,
	getSetupStatus,
	getWorkspace,
	listAgentKeys,
	listRoles,
	login,
	type Member,
	type Project,
	revokeAgentKey,
	rotateAgentKey,
	type ScheduledPost,
	saveBoard,
	saveCustomer,
	saveMember,
	savePost,
	saveProfile,
	saveProject,
	saveSettings,
	saveTask,
	type Task,
	type Workspace,
} from "./api";
import Files, { ProfileUpload } from "./Files";
import MemberAvatar from "./MemberAvatar";
import Reports from "./Reports";
import TaskDetails from "./TaskDetails";

type Page =
	| "overview"
	| "team"
	| "customers"
	| "projects"
	| "files"
	| "reports"
	| "roles"
	| "social"
	| "settings";
const pagePaths = {
	overview: "/",
	team: "/team",
	customers: "/customers",
	projects: "/projects",
	files: "/files",
	reports: "/reports",
	roles: "/roles",
	social: "/social",
	settings: "/settings",
} as const satisfies Record<Page, string>;
const pathPages = Object.fromEntries(
	Object.entries(pagePaths).map(([page, path]) => [path, page]),
) as Record<string, Page>;
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
	bio: string;
	avatarUrl: string;
	avatarFileId: string;
	role: string;
	kind: string;
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
	{ id: "files", label: "Files", icon: "▱" },
	{ id: "reports", label: "Reports", icon: "⌕" },
	{ id: "roles", label: "Roles & permissions", icon: "♙" },
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
	files: "Files",
	reports: "Reports",
	roles: "Roles & permissions",
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
const validAvatarUrl = (value: string) => {
	if (!value) return true;
	if (
		new TextEncoder().encode(value).length > 2048 ||
		/[\s\\\u0000-\u001f\u007f]/.test(value)
	)
		return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!!url.hostname &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
};

export default function App() {
	const matchedPath = useMatches({
		select: (matches) => matches.at(-1)?.fullPath,
	});
	const page = pathPages[matchedPath ?? ""] ?? "overview";
	const routerNavigate = useNavigate();
	const [sessionToken, setSessionToken] = useState(
		() => sessionStorage.getItem(tokenKey) || "",
	);
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
		!!data?.permissions.includes(`${area}:write`);
	const canView = (area: Page) =>
		area === "overview" ||
		area === "settings" ||
		area === "roles" ||
		(area === "files" &&
			["projects:read", "reports:read"].some((permission) =>
				data?.permissions.includes(permission),
			)) ||
		(area === "team" && me?.role === "admin") ||
		!!data?.permissions.includes(`${area}:read`);
	const navigate = (next: Page) => {
		if (canView(next)) {
			void routerNavigate({ to: pagePaths[next] });
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
		void routerNavigate({ to: "/" });
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
		onSuccess: (result) => {
			if (result && "secret" in result && result.secret) {
				setSecretToReveal(result.secret);
			}
			refresh();
		},
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
	if (!canView(page))
		return (
			<main className="grid min-h-screen place-content-center gap-4 bg-base-200 p-6 text-center">
				<h1 className="text-3xl font-semibold">Section unavailable</h1>
				<p className="text-base-content/70">
					Your role cannot open this office section.
				</p>
				<Link to="/" className="btn btn-primary">
					Return to overview
				</Link>
			</main>
		);
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
					bio: draft.bio,
					avatarUrl: draft.avatarUrl.trim(),
					avatarFileId: draft.avatarFileId,
					role: draft.role,
					kind: draft.kind || "human",
					status: draft.status,
					access: [],
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
									className="btn btn-ghost btn-circle"
									aria-label="Account menu"
								>
									<MemberAvatar
										name={me.name}
										avatarUrl={me.avatarUrl}
										avatarFileId={me.avatarFileId}
										className="size-9"
									/>
								</button>
								<ul className="menu dropdown-content z-30 mt-3 w-48 rounded-box bg-base-100 p-2 shadow">
									<li>
										<button onClick={() => navigate("settings")}>
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
									<MemberAvatar
										name={me.name}
										avatarUrl={me.avatarUrl}
										avatarFileId={me.avatarFileId}
										className="size-8"
									/>
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
						{page === "roles" && <RolesPage />}
						{page === "files" && <Files workspace={data} />}
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
								members={data.members}
								demoMode={data.demoMode}
								persistentStorage={data.persistentStorage}
								canManage={canManageTeam}
								theme={theme}
								onTheme={updateTheme}
								onSave={(value) => mutation.mutate({ kind: "settings", value })}
								onSaveProfile={async (bio, avatarUrl, avatarFileId) => {
									await saveProfile(bio, avatarUrl, avatarFileId);
									await queryClient.invalidateQueries({
										queryKey: ["workspace"],
									});
								}}
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
						<Link
							to="/"
							onClick={() => setNavigationOpen(false)}
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
						</Link>
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
								<MemberAvatar
									name={me.name}
									avatarUrl={me.avatarUrl}
									avatarFileId={me.avatarFileId}
								/>
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
			{secretToReveal && (
				<SecretReveal
					secret={secretToReveal}
					onClose={() => setSecretToReveal("")}
				/>
			)}
		</div>
	);
}

function SecretReveal({
	secret,
	onClose,
}: {
	secret: string;
	onClose: () => void;
}) {
	const [copyError, setCopyError] = useState("");
	return (
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
					<code>{secret}</code>
					<button
						className="btn btn-secondary btn-sm"
						autoFocus
						onClick={async () => {
							setCopyError("");
							try {
								await navigator.clipboard.writeText(secret);
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
						Use this key as the bearer credential for your MCP client. Access
						follows the AI user’s role. Do not put the key in browser storage or
						source control.
					</span>
				</div>
				<div className="modal-action">
					<button className="btn btn-primary" onClick={onClose}>
						Done
					</button>
				</div>
			</div>
			<button
				className="modal-backdrop"
				onClick={onClose}
				aria-label="Close key dialog"
			>
				Close
			</button>
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
				description="People and AI users in this workspace."
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
										<MemberAvatar
											name={person.name}
											avatarUrl={person.avatarUrl}
											avatarFileId={person.avatarFileId}
										/>
										<span>
											<b className="block">{person.name}</b>
											{person.kind === "agent" && (
												<span className="badge badge-secondary badge-sm">
													AI user
												</span>
											)}
											{person.bio && (
												<span className="mt-1 block max-w-md whitespace-pre-wrap text-sm text-base-content/70">
													{person.bio}
												</span>
											)}
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

function RolesPage() {
	const roles = useQuery({
		queryKey: ["roles"],
		queryFn: listRoles,
		retry: false,
	});
	return (
		<>
			<PageTitle
				eyebrow="Workspace access"
				heading="Roles & permissions"
				description="Roles are fixed presets. Humans and AI users share the same permissions, and AI keys inherit their user’s role."
			/>
			{roles.isPending && (
				<div className="py-4">
					<span
						className="loading loading-spinner"
						aria-label="Loading roles"
					/>
				</div>
			)}
			{roles.isError && (
				<div role="alert" className="alert alert-error">
					Could not load roles: {roles.error.message}
				</div>
			)}
			{roles.data && (
				<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
					<table className="table">
						<caption className="sr-only">
							Permissions assigned to each fixed role
						</caption>
						<thead>
							<tr>
								<th>Role</th>
								<th>Description</th>
								<th>Permissions</th>
							</tr>
						</thead>
						<tbody>
							{roles.data.roles.map((role) => (
								<tr key={role.id}>
									<th scope="row" className="capitalize">
										{role.name}
									</th>
									<td>{role.description}</td>
									<td>
										<div className="flex max-w-xl flex-wrap gap-1">
											{role.permissions.map((permission) => (
												<span
													className="badge badge-outline badge-sm"
													key={permission}
												>
													{permission}
												</span>
											))}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
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
					<div className="form-control">
						<label
							className="label-text mb-1"
							htmlFor={`${fieldId}-description`}
						>
							Description
						</label>
						<textarea
							id={`${fieldId}-description`}
							className="textarea textarea-bordered"
							value={value.description}
							onChange={(event) =>
								setValue({ ...value, description: event.target.value })
							}
							rows={3}
						/>
					</div>
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
	members,
	demoMode,
	persistentStorage,
	canManage,
	theme,
	onTheme,
	onSave,
	onSaveProfile,
	onSecret,
}: {
	data: Workspace;
	members: Member[];
	demoMode: boolean;
	persistentStorage: boolean;
	canManage: boolean;
	theme: string;
	onTheme: (theme: string) => void;
	onSave: (settings: Workspace["settings"]) => void;
	onSaveProfile: (
		bio: string,
		avatarUrl: string,
		avatarFileId: string,
	) => Promise<void>;
	onSecret: (secret: string) => void;
}) {
	const [workspaceName, setWorkspaceName] = useState(
		data.settings.workspaceName,
	);
	const [timezone, setTimezone] = useState(data.settings.timezone);
	const [keyError, setKeyError] = useState("");
	const [bio, setBio] = useState(data.currentUser.bio);
	const [avatarUrl, setAvatarUrl] = useState(data.currentUser.avatarUrl);
	const [avatarFileId, setAvatarFileId] = useState(
		data.currentUser.avatarFileId,
	);
	const [profileError, setProfileError] = useState("");
	const [profileSaved, setProfileSaved] = useState(false);
	const [profileBusy, setProfileBusy] = useState(false);
	const fieldId = useId();
	const queryClient = useQueryClient();
	useEffect(() => {
		setBio(data.currentUser.bio);
		setAvatarUrl(data.currentUser.avatarUrl);
		setAvatarFileId(data.currentUser.avatarFileId);
	}, [
		data.currentUser.bio,
		data.currentUser.avatarUrl,
		data.currentUser.avatarFileId,
	]);
	const keysQuery = useQuery({
		queryKey: ["agent-keys"],
		queryFn: listAgentKeys,
		enabled: canManage,
		retry: false,
	});
	const rotateKeyMutation = useMutation({
		mutationFn: rotateAgentKey,
		onSuccess: (result, memberId) => {
			onSecret(result.secret);
			if (memberId !== data.currentUser.id) {
				void queryClient.invalidateQueries({ queryKey: ["agent-keys"] });
			}
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
						<div className="flex items-center gap-3">
							<MemberAvatar
								name={data.currentUser.name}
								avatarUrl={data.currentUser.avatarUrl}
								avatarFileId={data.currentUser.avatarFileId}
								className="size-14"
							/>
							<h2 className="text-xl font-semibold">{data.currentUser.name}</h2>
						</div>
						<div className="grid gap-1 text-sm text-base-content/65">
							<span>{data.currentUser.email}</span>
							<span>
								{data.currentUser.jobTitle} · {data.currentUser.department}
							</span>
						</div>
						<ProfileUpload
							onUploaded={async (id) => {
								await onSaveProfile(bio, "", id);
								setAvatarFileId(id);
								setAvatarUrl("");
							}}
							onRemove={
								avatarFileId
									? async () => {
											await onSaveProfile(bio, "", "");
											setAvatarFileId("");
											setAvatarUrl("");
										}
									: undefined
							}
						/>
						<form
							className="mt-4 grid gap-3"
							onSubmit={async (event) => {
								event.preventDefault();
								setProfileError("");
								setProfileSaved(false);
								setProfileBusy(true);
								try {
									if (new TextEncoder().encode(bio).length > 2000)
										throw new Error("Bio must be 2000 bytes or fewer.");
									if (!validAvatarUrl(avatarUrl.trim()))
										throw new Error(
											"Enter an HTTPS image URL without credentials (2048 bytes maximum).",
										);
									await onSaveProfile(bio, avatarUrl.trim(), avatarFileId);
									setProfileSaved(true);
								} catch (error) {
									setProfileError(
										error instanceof Error
											? error.message
											: "Could not save your profile.",
									);
								} finally {
									setProfileBusy(false);
								}
							}}
						>
							<div className="form-control">
								<label
									htmlFor={`${fieldId}-profile-picture`}
									className="label-text mb-2 font-medium"
								>
									Profile picture URL (hosted HTTPS image)
								</label>
								<input
									id={`${fieldId}-profile-picture`}
									aria-describedby={`${fieldId}-profile-picture-help`}
									className="input input-bordered"
									type="url"
									value={avatarUrl}
									onChange={(event) => {
										setAvatarUrl(event.target.value);
										setAvatarFileId("");
									}}
									placeholder="https://example.com/photo.jpg"
								/>
								<span
									id={`${fieldId}-profile-picture-help`}
									className="label-text-alt mt-1"
								>
									A hosted URL replaces your uploaded picture. Leave blank to
									use initials.
								</span>
							</div>
							<label className="form-control">
								<span className="label-text mb-2 font-medium">Bio</span>
								<textarea
									className="textarea textarea-bordered min-h-24"
									maxLength={2000}
									value={bio}
									onChange={(event) => setBio(event.target.value)}
								/>
							</label>
							{profileError && (
								<p role="alert" className="text-sm text-error">
									{profileError}
								</p>
							)}
							{profileSaved && (
								<p role="status" className="text-sm text-success">
									Profile saved.
								</p>
							)}
							<button className="btn btn-primary w-fit" disabled={profileBusy}>
								{profileBusy && (
									<span className="loading loading-spinner loading-sm" />
								)}
								Save profile
							</button>
						</form>
						<div className="divider" />
						<span className="badge badge-primary badge-outline w-fit capitalize">
							{data.currentUser.role}
						</span>
						<p className="text-sm text-base-content/65">
							Your access:{" "}
							{data.currentUser.role === "admin"
								? "All modules"
								: data.permissions.join(", ") || "No business modules"}
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
							description="AI users receive a key when created. Rotate a key here if it needs replacing."
						/>
						<div
							className={`alert border text-sm ${persistentStorage ? "border-info/20 bg-info/10" : "border-warning/20 bg-warning/10"}`}
						>
							<span>ⓘ</span>
							<span>
								{!persistentStorage ? (
									<>
										Use each key as the bearer credential for your MCP client.
										Access follows the AI user’s role. Metadata resets when the
										server restarts.
									</>
								) : (
									<>
										Use each key as the bearer credential for your MCP client.
										Access follows the AI user’s role. Metadata is saved in
										SQLite.
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
						<div className="grid gap-2">
							{members
								.filter((member) => member.kind === "agent")
								.map((member) => (
									<div className="key-row" key={member.id}>
										<div>
											<b>{member.name}</b>
											<p>
												Role: <span className="capitalize">{member.role}</span>
											</p>
											<small>{member.status}</small>
										</div>
										{member.status === "active" && (
											<button
												className="btn btn-outline btn-sm"
												disabled={rotateKeyMutation.isPending}
												onClick={() => {
													setKeyError("");
													rotateKeyMutation.mutate(member.id);
												}}
											>
												Rotate key
											</button>
										)}
									</div>
								))}
							{!members.some((member) => member.kind === "agent") && (
								<p className="text-sm text-base-content/60">
									Create an AI user in Team to issue its first key.
								</p>
							)}
						</div>
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
										{members.some(
											(member) =>
												member.kind === "agent" && member.status === "active",
										)
											? "No agent keys have been created."
											: "Create an active AI user in Team before issuing a key."}
									</p>
								) : (
									keysQuery.data.keys.map((key) => (
										<article className="key-row" key={key.id}>
											<div>
												<b>{key.name}</b>
												<p>
													AI user:{" "}
													{members.find((member) => member.id === key.memberId)
														?.name || "Unknown AI user"}
												</p>
												<small>
													{key.revoked
														? "Revoked"
														: Number(key.expiresAt) * 1000 <= Date.now()
															? "Expired"
															: `Active · expires ${new Date(Number(key.expiresAt) * 1000).toLocaleDateString()}`}
												</small>
											</div>
											{!key.revoked &&
												Number(key.expiresAt) * 1000 > Date.now() && (
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
		bio: readString("bio"),
		avatarUrl: readString("avatarUrl"),
		avatarFileId: readString("avatarFileId"),
		role: readString("role", "member"),
		kind: readString("kind", "human"),
		password: "",
		customerId: readString("customerId"),
		summary: readString("summary"),
		targetDate: readString("targetDate"),
		connectionId: readString("connectionId", data.connections[0]?.id || ""),
		content: readString("content"),
		scheduledAt: readString("scheduledAt").slice(0, 16),
		authorId: readString("authorId", data.currentUser.id),
	}));
	type TextField = Exclude<keyof RecordDraft, "id" | "password">;
	type FieldConfig = {
		name: TextField;
		label: string;
		type?: string;
		options?: Array<[string, string]>;
		textarea?: boolean;
	};
	const memberFields: FieldConfig[] = [
		{ name: "name", label: "Name" },
		...(values.kind === "agent"
			? []
			: [{ name: "email" as const, label: "Email", type: "email" }]),
		{ name: "jobTitle", label: "Job title" },
		{ name: "department", label: "Department" },
		{ name: "bio", label: "Bio", textarea: true },
		{
			name: "avatarUrl",
			label: "Profile picture URL (hosted HTTPS image)",
			type: "url",
		},
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
			options:
				values.kind === "agent"
					? [
							["active", "Active"],
							["inactive", "Inactive"],
						]
					: [
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
		setValues((current) => ({
			...current,
			[name]: value,
			...(name === "avatarUrl" ? { avatarFileId: "" } : {}),
		}));
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
			values.kind !== "agent" &&
			values.email.trim() &&
			!v.safeParse(v.pipe(v.string(), v.email()), values.email).success
		) {
			setFormError("Enter a valid email address.");
			return;
		}
		if (
			kind === "member" &&
			values.kind !== "agent" &&
			values.password &&
			values.password.length < 12
		) {
			setFormError("Use at least 12 characters for a temporary password.");
			return;
		}
		if (
			kind === "member" &&
			new TextEncoder().encode(values.bio).length > 2000
		) {
			setFormError("Bio must be 2000 bytes or fewer.");
			return;
		}
		if (kind === "member" && !validAvatarUrl(values.avatarUrl.trim())) {
			setFormError(
				"Enter an HTTPS image URL without credentials (2048 bytes maximum).",
			);
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
						? values.kind === "agent"
							? "Saving an AI user creates a member-bound key. Copy its secret now; it is shown once."
							: "Adding someone records them here; it does not send an invitation."
						: kind === "post"
							? "This saves a queue record only. It will not publish to a channel."
							: "Save changes to the shared workspace."}
				</p>
				{kind === "member" && (
					<div className="form-control mt-4">
						<span className="label-text mb-2 font-medium">User type</span>
						{isEdit ? (
							<span className="badge badge-outline w-fit">
								{values.kind === "agent" ? "AI user" : "Human user"}
							</span>
						) : (
							<select
								aria-label="User type"
								className="select select-bordered"
								value={values.kind}
								onChange={(event) =>
									setValues((current) => ({
										...current,
										kind: event.target.value,
										email: event.target.value === "agent" ? "" : current.email,
										password:
											event.target.value === "agent" ? "" : current.password,
										status:
											event.target.value === "agent" &&
											current.status === "pending"
												? "active"
												: current.status,
									}))
								}
							>
								<option value="human">Human user</option>
								<option value="agent">AI user</option>
							</select>
						)}
					</div>
				)}
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
					{kind === "member" && values.kind !== "agent" && (
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
