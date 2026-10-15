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
	CreateAgentKeyRequestSchema,
	RevokeAgentKeyRequestSchema,
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
};
export type AgentKey = {
	id: string;
	name: string;
	scopes: string[];
	expiresAt: bigint;
	createdAt: bigint;
	revoked: boolean;
};
export type ScheduledPost = {
	id: string;
	connectionId: string;
	content: string;
	scheduledAt: string;
	status: string;
	authorId: string;
};
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
}) {
	return client.bootstrapAdmin(
		create(BootstrapAdminRequestSchema, {
			name: payload.name || "",
			email: payload.email,
			password: payload.password,
			workspaceName: payload.workspaceName || "",
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
export async function listAgentKeys() {
	return client.listAgentKeys(create(ListAgentKeysRequestSchema));
}
export async function createAgentKey(input: {
	name: string;
	scopes: string[];
	expiresInDays: number;
}) {
	return client.createAgentKey(create(CreateAgentKeyRequestSchema, input));
}
export async function revokeAgentKey(id: string) {
	return client.revokeAgentKey(create(RevokeAgentKeyRequestSchema, { id }));
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
