import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import ActionIcon from "./ActionIcon";
import {
	deleteFile,
	downloadFile,
	getFilePreviewBlob,
	listFiles,
	type Workspace,
} from "./api";
import type { FileRecord } from "./gen/office/v1/office_pb";

export const isGalleryImage = (file: FileRecord) =>
	["image/png", "image/jpeg", "image/webp"].includes(
		file.contentType.toLowerCase(),
	);

export function FileImage({
	id,
	name,
	size = "thumbnail",
}: {
	id: string;
	name: string;
	size?: "thumbnail" | "full";
}) {
	return (
		<FileImageContent key={`${id}-${size}`} id={id} name={name} size={size} />
	);
}

function FileImageContent({
	id,
	name,
	size,
}: {
	id: string;
	name: string;
	size: "thumbnail" | "full";
}) {
	const container = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(size === "full");
	const [source, setSource] = useState<{ blob: Blob; url: string }>();
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (size === "full") return;
		const element = container.current;
		if (!element) return;
		if (!("IntersectionObserver" in window)) {
			setVisible(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setVisible(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "250px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [size]);
	const query = useQuery({
		queryKey: ["file-preview", id, size],
		queryFn: () => getFilePreviewBlob(id, size),
		enabled: visible,
		retry: false,
		gcTime: 60_000,
		staleTime: 60_000,
	});
	useEffect(() => {
		setFailed(false);
		if (!query.data) {
			setSource(undefined);
			return;
		}
		const url = URL.createObjectURL(query.data);
		setSource({ blob: query.data, url });
		return () => URL.revokeObjectURL(url);
	}, [query.data]);
	return (
		<div
			ref={container}
			className={`flex w-full items-center justify-center bg-base-200 ${size === "full" ? "min-h-52" : "aspect-square"}`}
		>
			{query.error || failed ? (
				<div className="grid justify-items-center gap-2 p-4 text-center text-sm">
					<span>Preview unavailable</span>
					<button
						type="button"
						className="btn btn-ghost btn-xs"
						onClick={(event) => {
							event.stopPropagation();
							setFailed(false);
							void query.refetch();
						}}
					>
						<ActionIcon name="refresh" />
						Retry preview
					</button>
				</div>
			) : source && source.blob === query.data ? (
				<img
					src={source.url}
					alt={name}
					loading={size === "full" ? "eager" : "lazy"}
					className={
						size === "full"
							? "max-h-[65vh] w-full object-contain"
							: "h-full w-full object-cover"
					}
					onError={() => setFailed(true)}
				/>
			) : (
				<span role="status" className="text-sm text-base-content/60">
					{visible ? "Loading image…" : "Image"}
				</span>
			)}
		</div>
	);
}

const categoryName = (module: string) =>
	module === "profile"
		? "Profile pictures"
		: module === "projects"
			? "Projects"
			: "Reports";
export function ImageGallery({
	workspace,
	onUpload,
}: {
	workspace: Workspace;
	onUpload: () => void;
}) {
	const [category, setCategory] = useState("");
	const [project, setProject] = useState("");
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<FileRecord>();
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const dialog = useRef<HTMLDialogElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const titleId = useId();
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: ["files", "gallery", "all"],
		queryFn: () => listFiles(""),
		retry: false,
	});
	const uploader = (file: FileRecord) =>
		workspace.members.find((member) => member.id === file.uploadedBy)?.name ||
		"Office member";
	const images = (query.data?.files || []).filter(isGalleryImage);
	const filtered = images.filter(
		(file) =>
			(!category || category === file.module) &&
			(!project || (file.module === "projects" && project === file.recordId)) &&
			`${file.name} ${uploader(file)}`
				.toLowerCase()
				.includes(search.toLowerCase()),
	);
	const canDelete =
		selected &&
		(selected.module === "profile"
			? selected.uploadedBy === workspace.currentUser.id ||
				workspace.currentUser.role === "admin"
			: workspace.permissions.includes(`${selected.module}:write`));
	const close = useCallback(() => {
		dialog.current?.close();
		setSelected(undefined);
		setConfirmDelete(false);
		setError("");
		opener.current?.focus();
	}, []);
	useEffect(() => {
		if (selected && dialog.current && !dialog.current.open)
			dialog.current.showModal();
	}, [selected]);
	useEffect(() => {
		if (
			selected &&
			query.data &&
			!query.data.files.some((file) => file.id === selected.id)
		)
			close();
	}, [query.data, selected, close]);

	async function act(action: () => Promise<void>) {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (error) {
			setError(
				error instanceof Error
					? error.message
					: "The file request failed. Try again.",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="grid gap-5" aria-label="Image gallery">
			<div className="flex flex-wrap items-end gap-3">
				<label className="form-control min-w-48 flex-1">
					<span className="mb-2 text-sm font-medium">Search images</span>
					<input
						className="input input-bordered w-full"
						type="search"
						placeholder="Filename or uploader"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</label>
				<label className="form-control">
					<span className="mb-2 text-sm font-medium">Category</span>
					<select
						className="select select-bordered"
						value={category}
						onChange={(event) => {
							setCategory(event.target.value);
							setProject("");
						}}
					>
						<option value="">All categories</option>
						{["projects", "reports", "profile"].map((value) => (
							<option key={value} value={value}>
								{categoryName(value)}
							</option>
						))}
					</select>
				</label>
				{(!category || category === "projects") && (
					<label className="form-control">
						<span className="mb-2 text-sm font-medium">Project</span>
						<select
							className="select select-bordered"
							value={project}
							onChange={(event) => setProject(event.target.value)}
						>
							<option value="">All projects</option>
							{workspace.projects.map((item) => (
								<option value={item.id} key={item.id}>
									{item.name}
								</option>
							))}
						</select>
					</label>
				)}
				<button
					type="button"
					className="btn btn-ghost"
					disabled={query.isFetching}
					onClick={() => void query.refetch()}
				>
					<ActionIcon name="refresh" />
					Refresh images
				</button>
				{["projects", "reports"].some((module) =>
					workspace.permissions.includes(`${module}:write`),
				) && (
					<button type="button" className="btn btn-primary" onClick={onUpload}>
						<ActionIcon name="upload" />
						Upload files
					</button>
				)}
			</div>
			{query.data && !query.data.storageConfigured && (
				<p role="status" className="alert alert-info">
					File storage is not configured yet. An operator must configure private
					storage before uploads are available.
				</p>
			)}
			{query.error ? (
				<p role="alert" className="text-error">
					{query.error.message} Use Refresh images to try again.
				</p>
			) : query.isPending ? (
				<p role="status">Loading images…</p>
			) : (
				<>
					<p role="status" className="text-sm text-base-content/60">
						{filtered.length} {filtered.length === 1 ? "image" : "images"}
						{filtered.length !== images.length ? ` of ${images.length}` : ""}
					</p>
					{filtered.length ? (
						<ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
							{filtered.map((file) => (
								<li key={file.id} className="min-w-0">
									<div className="relative overflow-hidden rounded-box border border-base-300">
										<FileImage key={file.id} id={file.id} name={file.name} />
										<button
											type="button"
											className="btn btn-sm absolute right-2 bottom-2"
											aria-label={`Preview ${file.name}`}
											disabled={busy}
											onClick={(event) => {
												opener.current = event.currentTarget;
												setSelected(file);
											}}
										>
											<ActionIcon name="image" />
											Preview
										</button>
									</div>
									<p
										className="mt-2 truncate text-sm font-medium"
										title={file.name}
									>
										{file.name}
									</p>
									<p className="truncate text-xs text-base-content/60">
										{uploader(file)}
									</p>
									<p className="truncate text-xs text-base-content/60">
										{categoryName(file.module)}
										{file.module === "projects" && file.recordId
											? ` / ${workspace.projects.find((item) => item.id === file.recordId)?.name || "Linked project"}`
											: ""}
									</p>
								</li>
							))}
						</ul>
					) : (
						<div className="rounded-box bg-base-200/50 p-10 text-center">
							<h3 className="font-semibold">
								{images.length ? "No matching images" : "No images yet"}
							</h3>
							<p className="mt-2 text-sm text-base-content/60">
								{images.length
									? "Try another search or category."
									: "Upload PNG, JPEG or WebP files to a project or report. Saved profile pictures also appear here."}
							</p>
						</div>
					)}
				</>
			)}
			<dialog
				ref={dialog}
				className="modal"
				aria-labelledby={titleId}
				onCancel={(event) => {
					event.preventDefault();
					close();
				}}
				onClose={() => {
					if (selected) close();
				}}
			>
				<div className="modal-box w-11/12 max-w-5xl">
					<div className="mb-4 flex items-start justify-between gap-4">
						<div className="min-w-0">
							<h3 id={titleId} className="break-words text-lg font-semibold">
								{selected?.name || "Image preview"}
							</h3>
							{selected && (
								<p className="text-sm text-base-content/60">
									{uploader(selected)} / {categoryName(selected.module)} /{" "}
									{selected.createdAt
										? new Date(selected.createdAt).toLocaleDateString()
										: ""}
								</p>
							)}
						</div>
						<button
							type="button"
							className="btn btn-ghost btn-square btn-sm"
							aria-label="Close"
							title="Close"
							onClick={close}
						>
							<ActionIcon name="close" />
						</button>
					</div>
					{selected && (
						<FileImage
							key={`${selected.id}-full`}
							id={selected.id}
							name={selected.name}
							size="full"
						/>
					)}
					{error && (
						<p role="alert" className="mt-3 text-sm text-error">
							{error}
						</p>
					)}
					<div className="modal-action flex-wrap">
						{selected && (
							<button
								type="button"
								className="btn btn-outline"
								disabled={busy}
								onClick={() =>
									void act(() => downloadFile(selected.id, selected.name))
								}
							>
								<ActionIcon name="download" />
								Download
							</button>
						)}
						{canDelete &&
							(confirmDelete ? (
								<>
									<span className="w-full text-sm">
										Delete this file from the office? Its history is retained.
									</span>
									<button
										type="button"
										className="btn btn-error"
										disabled={busy}
										onClick={() =>
											void act(async () => {
												if (!selected) return;
												await deleteFile(selected.id, selected.revision);
												await Promise.all([
													queryClient.invalidateQueries({
														queryKey: ["files"],
													}),
													queryClient.invalidateQueries({
														queryKey: ["workspace"],
													}),
												]);
												queryClient.removeQueries({
													queryKey: ["file-preview", selected.id],
												});
												close();
											})
										}
									>
										<ActionIcon name="trash" />
										Confirm delete
									</button>
									<button
										type="button"
										className="btn btn-ghost"
										disabled={busy}
										onClick={() => setConfirmDelete(false)}
									>
										Cancel
									</button>
								</>
							) : (
								<button
									type="button"
									className="btn btn-ghost text-error"
									disabled={busy}
									onClick={() => setConfirmDelete(true)}
								>
									<ActionIcon name="trash" />
									Delete
								</button>
							))}
					</div>
				</div>
			</dialog>
		</section>
	);
}
