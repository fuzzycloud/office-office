import { create } from "@bufbuild/protobuf";
import {
	Code,
	ConnectError,
	createClient,
	type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import type {
	Report as GeneratedReport,
	GetWorkspaceResponse,
	WorkspaceSettings,
} from "./gen/office/v1/office_pb";
import {
	BoardSchema,
	BootstrapAdminRequestSchema,
	CustomerSchema,
	DeleteFileRequestSchema,
	DeleteTaskCommentRequestSchema,
	GetReportRequestSchema,
	GetSetupStatusRequestSchema,
	GetWorkspaceRequestSchema,
	ListAgentKeysRequestSchema,
	ListFilesRequestSchema,
	ListReportsRequestSchema,
	ListRolesRequestSchema,
	ListTaskDiscussionRequestSchema,
	LoginRequestSchema,
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
	WorkspaceSettingsSchema,
} from "./gen/office/v1/office_pb";

const key = "office-office-session";
function requireCurrentSession(token: string | undefined) {
	if (token && sessionStorage.getItem(key)?.trim() !== token)
		throw new ConnectError(
			"The session changed during this request.",
			Code.Canceled,
		);
}
const authInterceptor: Interceptor = (next) => async (request) => {
	const token = sessionStorage.getItem(key)?.trim();
	if (token) request.header.set("Authorization", `Bearer ${token}`);
	try {
		const response = await next(request);
		requireCurrentSession(token);
		return response;
	} catch (error) {
		requireCurrentSession(token);
		if (
			error instanceof ConnectError &&
			error.code === Code.Unauthenticated &&
			token &&
			sessionStorage.getItem(key)?.trim() === token
		) {
			sessionStorage.removeItem(key);
			window.location.reload();
		}
		throw error;
	}
};
const client = createClient(
	OfficeService,
	createConnectTransport({
		baseUrl: `${window.location.origin}/rpc`,
		interceptors: [authInterceptor],
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
export async function bootstrapAdmin(payload: {
	name?: string;
	email: string;
	password: string;
	workspaceName?: string;
	loadDemoData: boolean;
}) {
	return client.bootstrapAdmin(
		create(BootstrapAdminRequestSchema, {
			name: payload.name || "",
			email: payload.email,
			password: payload.password,
			workspaceName: payload.workspaceName || "",
			loadDemoData: payload.loadDemoData,
		}),
	);
}
export async function login(email: string, password: string) {
	return client.login(create(LoginRequestSchema, { email, password }));
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
	if (token) headers.set("Authorization", `Bearer ${token}`);
	const response = await fetch(path, { ...init, headers });
	requireCurrentSession(token);
	if (response.status === 401 && token) {
		sessionStorage.removeItem(key);
		window.location.reload();
	}
	if (!response.ok)
		throw new Error(
			`File request failed (${response.status}). ${await response.text()}`,
		);
	return { response, token };
}
export async function uploadFile(file: File, module: string, recordId = "") {
	const query = new URLSearchParams({
		module,
		record_id: recordId,
		name: file.name,
	});
	const { response, token } = await fileRequest(`/api/files?${query}`, {
		method: "POST",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	const result = (await response.json()) as { file?: { id?: string } };
	requireCurrentSession(token);
	if (!result.file?.id)
		throw new Error("The upload response is missing its file.");
	return result.file.id;
}
export async function getFileBlob(id: string) {
	const { response, token } = await fileRequest(
		`/api/files/${encodeURIComponent(id)}/content`,
	);
	const blob = await response.blob();
	requireCurrentSession(token);
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
