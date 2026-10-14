import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { OfficeService } from "./gen/office/v1/office_pb";

const authInterceptor: Interceptor = (next) => async (req) => {
	const identity = sessionStorage.getItem("office-office-identity") ?? "human";
	const tokenKey = `office-office-${identity}-token`;
	const stored =
		sessionStorage.getItem(tokenKey) ??
		(identity === "human"
			? sessionStorage.getItem("office-office-token")
			: null);
	const token = stored?.trim();
	if (token)
		req.header.set(
			"Authorization",
			token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`,
		);
	return next(req);
};

const client = createClient(
	OfficeService,
	createConnectTransport({
		baseUrl: `${window.location.origin}/rpc`,
		interceptors: [authInterceptor],
	}),
);

export type Entry = {
	id: string;
	title: string;
	detail?: string;
	status?: string;
	owner?: string;
};
export type Target = Entry & {
	current?: number;
	target?: number;
	unit?: string;
};
export type Price = {
	id: string;
	projectId?: string;
	amountMinor: number;
	currency: string;
	effectiveOn: string;
	detail?: string;
};
export type Connector = {
	id: string;
	provider: string;
	mode: string;
	syncStatus: string;
};
export type Board = {
	targets: Target[];
	projects: Entry[];
	strategies: Entry[];
	prices: Price[];
	updates: Entry[];
	connectors: Connector[];
};

export async function getBoard(): Promise<Board> {
	const response = await client.getBoard({});
	if (!response.boardJson) return emptyBoard();
	const board = JSON.parse(response.boardJson) as Partial<Board>;
	return { ...emptyBoard(), ...board };
}

export async function saveBoard(board: Board): Promise<void> {
	await client.saveBoard({ boardJson: JSON.stringify(board) });
}

export function emptyBoard(): Board {
	return {
		targets: [],
		projects: [],
		strategies: [],
		prices: [],
		updates: [],
		connectors: [],
	};
}
