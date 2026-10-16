import { create } from "@bufbuild/protobuf";
import {
	Code,
	ConnectError,
	createClient,
	type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import type {
	Notification as GeneratedNotification,
	Report as GeneratedReport,
	GetWorkspaceResponse,
	WorkspaceSettings,
} from "./gen/office/v1/office_pb";
import {
	BoardSchema,
	CreateNotificationRequestSchema,
	CustomerSchema,
	DeleteFileRequestSchema,
	DeleteTaskCommentRequestSchema,
	GetReportRequestSchema,
	GetSetupStatusRequestSchema,
	GetWorkspaceRequestSchema,
	ListAgentKeysRequestSchema,
	ListFilesRequestSchema,
	ListNotificationsRequestSchema,
	ListReportsRequestSchema,
	ListRolesRequestSchema,
	ListTaskDiscussionRequestSchema,
	MemberSchema,
	OfficeService,
	ProjectSchema,
	ReportSchema,
	RevokeAgentKeyRequestSchema,
	RotateAgentKeyRequestSchema,
	SaveBoardRequestSchema,
	SaveCustomerRequestSchema,
	SaveMemberRequestSchema,
	SavePostRequestSchema,
	SaveProfileRequestSchema,
	SaveProjectRequestSchema,
	SaveReportRequestSchema,
	SaveSettingsRequestSchema,
	SaveTaskCommentRequestSchema,
	SaveTaskRequestSchema,
	ScheduledPostSchema,
	TaskSchema,
	UpdateNotificationRequestSchema,
	WorkspaceSettingsSchema,
} from "./gen/office/v1/office_pb";

const key = "office-office-session";
const generationKey = "office-office-session-generation";
export const sessionChangedEvent = "office-office-session-changed";
export const sessionExpiredMessage =
	"Your session expired. Sign in again to continue.";
const isCookieSession = (token?: string | null) =>
	!!token?.startsWith("cookie:");
const generation = () => localStorage.getItem(generationKey);
const sessionIdentity = () =>
	`${sessionStorage.getItem(key) || ""}:${generation() || ""}`;
function requireCurrentSession(identity: string) {
	if (identity !== sessionIdentity())
		throw new ConnectError(
			"The session changed during this request.",
			Code.Canceled,
		);
}
function announceSession(reason: string) {
	window.dispatchEvent(
		new CustomEvent(sessionChangedEvent, { detail: reason }),
	);
}
function invalidateSession(token: string | undefined) {
	if (!token || sessionStorage.getItem(key)?.trim() !== token) return;
	sessionStorage.removeItem(key);
	if (isCookieSession(token)) announceSession("expired");
	else window.location.reload();
}
function establishCookieSession() {
	const token = `cookie:${crypto.randomUUID()}`;
	sessionStorage.setItem(key, token);
	return token;
}
function broadcastSessionChange() {
	localStorage.setItem(generationKey, crypto.randomUUID());
}
window.addEventListener("storage", (event) => {
	if (event.key !== generationKey) return;
	// Invalidate request identities immediately, before React starts recovery.
	sessionStorage.removeItem(key);
	announceSession("changed");
});
const authInterceptor: Interceptor = (next) => async (request) => {
	const token = sessionStorage.getItem(key)?.trim();
	const identity = sessionIdentity();
	const publicRequest = request.method.name === "GetSetupStatus";
	if (token && !isCookieSession(token))
		request.header.set("Authorization", `Bearer ${token}`);
	request.header.set("X-Office-CSRF", "1");
	try {
		const response = await next(request);
		if (!publicRequest) requireCurrentSession(identity);
		return response;
	} catch (error) {
		if (!publicRequest) requireCurrentSession(identity);
		if (
			!publicRequest &&
			error instanceof ConnectError &&
			error.code === Code.Unauthenticated
		)
			invalidateSession(token);
		throw error;
	}
};
const client = createClient(
	OfficeService,
	createConnectTransport({
		baseUrl: `${window.location.origin}/rpc`,
		interceptors: [authInterceptor],
		fetch: (input, init) =>
			fetch(input, { ...init, credentials: "same-origin" }),
	}),
);

export type Member = {
	id: string;
	name: string;
	email: string;
	jobTitle: string;
	department: string;
	bio: string;
	avatarUrl: string;
	avatarFileId?: string;
	role: string;
	status: string;
	access: string[];
	kind: string;
	password?: string;
};
export type Customer = {
	id: string;
	name: string;
	company: string;
	email: string;
	status: string;
	ownerId: string;
	notes: string;
};
export type Project = {
	id: string;
	name: string;
	customerId: string;
	ownerId: string;
	status: string;
	summary: string;
	targetDate: string;
};
export type Board = {
	id: string;
	projectId: string;
	name: string;
	columns: string[];
};
export type Task = {
	id: string;
	projectId: string;
	boardId: string;
	column: string;
	title: string;
	description: string;
	assigneeId: string;
	priority: string;
	dueDate: string;
	commentCount?: number;
};
export type AgentKey = {
	id: string;
	name: string;
	scopes: string[];
	expiresAt: bigint;
	createdAt: bigint;
	revoked: boolean;
	memberId: string;
	issuedBy: string;
};
export type ScheduledPost = {
	id: string;
	connectionId: string;
	content: string;
	scheduledAt: string;
	status: string;
	authorId: string;
};
export type Report = GeneratedReport;
export type Workspace = GetWorkspaceResponse & {
	settings: WorkspaceSettings;
	currentUser: NonNullable<GetWorkspaceResponse["currentUser"]>;
};
export async function getSetupStatus() {
	return client.getSetupStatus(create(GetSetupStatusRequestSchema));
}
type BrowserSession = {
	user: { id: string; name: string; role: string };
	expiresAt?: number | string;
};
async function authRequest(
	path: string,
	payload?: unknown,
	onSuccessHeaders?: () => void,
): Promise<BrowserSession> {
	const response = await fetch(path, {
		method: payload === undefined ? "GET" : "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json", "X-Office-CSRF": "1" },
		...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
	});
	if (!response.ok) {
		let message = `Authentication request failed (${response.status}).`;
		try {
			const body = await response.json();
			if (typeof body.message === "string") message = body.message;
			else if (typeof body.error === "string") message = body.error;
		} catch {
			/* Keep a readable fallback for non-JSON failures. */
		}
		throw new ConnectError(
			message,
			response.status === 401 ? Code.Unauthenticated : Code.Unknown,
		);
	}
	// Fetch has already applied Set-Cookie when headers become available.
	onSuccessHeaders?.();
	return response.json();
}
let recovery: { identity: string; promise: Promise<string> } | undefined;
export function recoverBrowserSession() {
	const identity = sessionIdentity();
	if (!recovery || recovery.identity !== identity) {
		const promise = recoverSession().finally(() => {
			if (recovery?.promise === promise) recovery = undefined;
		});
		recovery = { identity, promise };
	}
	return recovery.promise;
}
async function recoverSession() {
	const identity = sessionIdentity();
	try {
		await authRequest("/auth/session");
		requireCurrentSession(identity);
		return establishCookieSession();
	} catch (error) {
		requireCurrentSession(identity);
		if (error instanceof ConnectError && error.code === Code.Unauthenticated) {
			sessionStorage.removeItem(key);
			return "";
		}
		throw error;
	}
}
function cookieChanged(identity: string, signedIn: boolean) {
	const wasCurrent = identity === sessionIdentity();
	// Every successful cookie response changes the shared credential, even when
	// its initiating session is stale. Invalidate other tabs before reading a body.
	broadcastSessionChange();
	if (!wasCurrent) {
		sessionStorage.removeItem(key);
		announceSession("changed");
		throw new ConnectError(
			"The session changed during this request.",
			Code.Canceled,
		);
	}
	const token = signedIn ? establishCookieSession() : "";
	if (!signedIn) sessionStorage.removeItem(key);
	return { token, identity: sessionIdentity() };
}
async function createBrowserSession(path: string, payload: unknown) {
	const identity = sessionIdentity();
	let activated: ReturnType<typeof cookieChanged> | undefined;
	try {
		const session = await authRequest(path, payload, () => {
			activated = cookieChanged(identity, true);
		});
		if (!activated)
			throw new Error("The authentication response is missing its session.");
		requireCurrentSession(activated.identity);
		return { ...session, sessionId: activated.token };
	} catch (error) {
		// A truncated or invalid body must not leave a changed cookie paired with
		// the previous UI account. Recover the cookie through the session endpoint.
		if (activated && activated.identity === sessionIdentity()) {
			sessionStorage.removeItem(key);
			announceSession("changed");
		}
		throw error;
	}
}
export async function bootstrapAdmin(payload: {
	name?: string;
	email: string;
	password: string;
	workspaceName?: string;
	loadDemoData: boolean;
}) {
	return createBrowserSession("/auth/bootstrap", payload);
}
export async function login(email: string, password: string) {
	return createBrowserSession("/auth/login", { email, password });
}
export async function logout() {
	const identity = sessionIdentity();
	const response = await fetch("/auth/logout", {
		method: "POST",
		credentials: "same-origin",
		headers: { "X-Office-CSRF": "1" },
	});
	if (!response.ok) {
		requireCurrentSession(identity);
		throw new Error(`Sign out failed (${response.status}). Try again.`);
	}
	cookieChanged(identity, false);
}
export async function getWorkspace(): Promise<Workspace> {
	const response = await client.getWorkspace(create(GetWorkspaceRequestSchema));
	if (!response.settings || !response.currentUser)
		throw new Error(
			"The workspace response is missing its settings or signed-in user.",
		);
	return {
		...response,
		settings: response.settings,
		currentUser: response.currentUser,
	};
}
export async function saveMember(member: Member) {
	const { password = "", ...record } = member;
	return client.saveMember(
		create(SaveMemberRequestSchema, {
			member: create(MemberSchema, record),
			password,
		}),
	);
}
export async function saveProfile(
	bio: string,
	avatarUrl: string,
	avatarFileId = "",
) {
	return client.saveProfile(
		create(SaveProfileRequestSchema, { bio, avatarUrl, avatarFileId }),
	);
}
export async function listRoles() {
	return client.listRoles(create(ListRolesRequestSchema));
}
export async function saveCustomer(customer: Customer) {
	return client.saveCustomer(
		create(SaveCustomerRequestSchema, {
			customer: create(CustomerSchema, customer),
		}),
	);
}
export async function saveProject(project: Project) {
	return client.saveProject(
		create(SaveProjectRequestSchema, {
			project: create(ProjectSchema, project),
		}),
	);
}
export async function saveBoard(board: Board) {
	return client.saveBoard(
		create(SaveBoardRequestSchema, { board: create(BoardSchema, board) }),
	);
}
export async function saveTask(task: Task) {
	return client.saveTask(
		create(SaveTaskRequestSchema, { task: create(TaskSchema, task) }),
	);
}
export async function listReports(input: {
	query: string;
	status: string;
	projectId?: string;
	pageSize: number;
	offset: number;
}) {
	return client.listReports(
		create(ListReportsRequestSchema, {
			...input,
			projectId: input.projectId ?? "",
		}),
	);
}
export async function getReport(id: string) {
	const response = await client.getReport(
		create(GetReportRequestSchema, { id }),
	);
	if (!response.report)
		throw new Error("The report response is missing its report.");
	return response;
}
export async function saveReport(
	report: Omit<Report, "$typeName" | "sources"> & {
		sources: Array<{ title: string; url: string }>;
	},
	expectedRevision: number,
) {
	const response = await client.saveReport(
		create(SaveReportRequestSchema, {
			report: create(ReportSchema, report),
			expectedRevision,
		}),
	);
	if (!response.report)
		throw new Error("The save response is missing its report.");
	return response.report;
}
export async function listAgentKeys() {
	return client.listAgentKeys(create(ListAgentKeysRequestSchema));
}
export async function revokeAgentKey(id: string) {
	return client.revokeAgentKey(create(RevokeAgentKeyRequestSchema, { id }));
}
export async function rotateAgentKey(memberId: string) {
	return client.rotateAgentKey(
		create(RotateAgentKeyRequestSchema, { memberId }),
	);
}
export async function savePost(post: ScheduledPost) {
	return client.savePost(
		create(SavePostRequestSchema, { post: create(ScheduledPostSchema, post) }),
	);
}
export async function saveSettings(settings: WorkspaceSettings) {
	return client.saveSettings(
		create(SaveSettingsRequestSchema, {
			settings: create(WorkspaceSettingsSchema, settings),
		}),
	);
}

export async function listTaskDiscussion(taskId: string) {
	return client.listTaskDiscussion(
		create(ListTaskDiscussionRequestSchema, { taskId }),
	);
}
export async function saveTaskComment(input: {
	taskId: string;
	commentId: string;
	body: string;
	expectedRevision: number;
}) {
	return client.saveTaskComment(create(SaveTaskCommentRequestSchema, input));
}
export async function deleteTaskComment(input: {
	taskId: string;
	commentId: string;
	expectedRevision: number;
}) {
	return client.deleteTaskComment(
		create(DeleteTaskCommentRequestSchema, input),
	);
}

export async function listFiles(module: string, recordId = "") {
	return client.listFiles(create(ListFilesRequestSchema, { module, recordId }));
}
export async function deleteFile(id: string, expectedRevision: number) {
	return client.deleteFile(
		create(DeleteFileRequestSchema, { id, expectedRevision }),
	);
}
async function fileRequest(path: string, init?: RequestInit) {
	const headers = new Headers(init?.headers);
	const token = sessionStorage.getItem(key)?.trim();
	const identity = sessionIdentity();
	if (token && !isCookieSession(token))
		headers.set("Authorization", `Bearer ${token}`);
	headers.set("X-Office-CSRF", "1");
	const response = await fetch(path, {
		...init,
		headers,
		credentials: "same-origin",
	});
	requireCurrentSession(identity);
	if (response.status === 401) {
		invalidateSession(token);
		throw new Error(sessionExpiredMessage);
	}
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300).trim();
		requireCurrentSession(identity);
		throw new Error(
			`File request failed (${response.status}).${detail ? ` ${detail}` : ""}`,
		);
	}
	return { response, identity };
}
export async function uploadFile(file: File, module: string, recordId = "") {
	const query = new URLSearchParams({
		module,
		record_id: recordId,
		name: file.name,
	});
	const { response, identity } = await fileRequest(`/api/files?${query}`, {
		method: "POST",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	const result = (await response.json()) as { file?: { id?: string } };
	requireCurrentSession(identity);
	if (!result.file?.id)
		throw new Error("The upload response is missing its file.");
	return result.file.id;
}
export async function getFileBlob(id: string) {
	const { response, identity } = await fileRequest(
		`/api/files/${encodeURIComponent(id)}/content`,
	);
	const blob = await response.blob();
	requireCurrentSession(identity);
	return blob;
}
export async function getFilePreviewBlob(
	id: string,
	size: "thumbnail" | "full",
) {
	const { response, identity } = await fileRequest(
		`/api/files/${encodeURIComponent(id)}/preview?size=${size}`,
	);
	const blob = await response.blob();
	requireCurrentSession(identity);
	return blob;
}
export async function downloadFile(id: string, name: string) {
	const blob = await getFileBlob(id);
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement("a");
		link.href = url;
		link.download = name;
		link.click();
	} finally {
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}

export type Notification = GeneratedNotification;
export type NotificationDraft = {
	requestId: string;
	title: string;
	body: string;
	kind: string;
	recipientIds: string[];
	sourceKind: string;
	sourceId: string;
};
export async function createNotification(input: NotificationDraft) {
	return client.createNotification(
		create(CreateNotificationRequestSchema, input),
	);
}
export async function listNotifications(input: {
	scope: string;
	status: string;
	pageSize: number;
	offset: number;
}) {
	return client.listNotifications(
		create(ListNotificationsRequestSchema, input),
	);
}
export async function updateNotification(input: {
	id: string;
	expectedRevision: number;
	action: string;
	claimId: string;
	note: string;
}) {
	return client.updateNotification(
		create(UpdateNotificationRequestSchema, input),
	);
}
