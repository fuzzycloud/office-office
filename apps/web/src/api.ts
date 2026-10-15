import {
	Code,
	ConnectError,
	createClient,
	type Interceptor,
} from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
	BootstrapAdminRequestSchema,
	CustomerSchema,
	BoardSchema,
	TaskSchema,
	ListTaskDiscussionRequestSchema,
	SaveTaskCommentRequestSchema,
	DeleteTaskCommentRequestSchema,
	ListReportsRequestSchema,
	GetReportRequestSchema,
	SaveReportRequestSchema,
	ReportSchema,
	GetSetupStatusRequestSchema,
	GetWorkspaceRequestSchema,
	LoginRequestSchema,
	MemberSchema,
	OfficeService,
	ProjectSchema,
	SaveCustomerRequestSchema,
	SaveBoardRequestSchema,
	SaveTaskRequestSchema,
	ListAgentKeysRequestSchema,
	RevokeAgentKeyRequestSchema,
	RotateAgentKeyRequestSchema,
	ListRolesRequestSchema,
	SaveMemberRequestSchema,
	SavePostRequestSchema,
	SaveProjectRequestSchema,
	SaveSettingsRequestSchema,
	ScheduledPostSchema,
	WorkspaceSettingsSchema,
} from "./gen/office/v1/office_pb";
import type {
	GetWorkspaceResponse,
	WorkspaceSettings,
	Report as GeneratedReport,
} from "./gen/office/v1/office_pb";

const key = "office-office-session";
const authInterceptor: Interceptor = (next) => async (request) => {
	const token = sessionStorage.getItem(key)?.trim();
	if (token) request.header.set("Authorization", `Bearer ${token}`);
	try {
		return await next(request);
	} catch (error) {
		if (
			error instanceof ConnectError &&
			error.code === Code.Unauthenticated &&
			token
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
