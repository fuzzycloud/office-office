import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import {
	deleteFile,
	downloadFile,
	listFiles,
	uploadFile,
	type Workspace,
} from "./api";
import { FileImage, ImageGallery, isGalleryImage } from "./FileImages";

const errorMessage = (error: unknown) =>
	error instanceof Error
		? error.message
		: "The file request failed. Please try again.";
const fileSize = (size: bigint) =>
	Number(size) < 1024
		? `${size} B`
		: Number(size) < 1024 * 1024
			? `${(Number(size) / 1024).toFixed(1)} KB`
			: `${(Number(size) / 1024 / 1024).toFixed(1)} MB`;

export default function Files({ workspace }: { workspace: Workspace }) {
	const modules = ["projects", "reports"].filter((module) =>
		workspace.permissions.includes(`${module}:read`),
	);
	const [tab, setTab] = useState("files");
	const [module, setModule] = useState(modules[0] || "projects");
	const [recordId, setRecordId] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [pendingDelete, setPendingDelete] = useState("");
	const [inputKey, setInputKey] = useState(0);
	const fieldId = useId();
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: ["files", module, recordId],
		queryFn: () => listFiles(module, recordId),
		retry: false,
	});
	const canWrite = workspace.permissions.includes(`${module}:write`);
	async function upload(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!file) return;
		setError("");
		setNotice("");
		setBusy(true);
		try {
			if (file.size > 10 * 1024 * 1024)
				throw new Error("Attachments must be 10 MiB or smaller.");
			await uploadFile(file, module, recordId);
			setFile(null);
			setInputKey((key) => key + 1);
			setNotice("File uploaded.");
			await queryClient.invalidateQueries({ queryKey: ["files"] });
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setBusy(false);
		}
	}
	async function run(action: () => Promise<unknown>) {
		setError("");
		setNotice("");
		setBusy(true);
		try {
			await action();
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="grid gap-5">
			<header>
				<h2 className="mt-1 text-2xl font-semibold">
					Project and research files
				</h2>
				<p className="mt-2 max-w-2xl text-base-content/65">
					Keep project assets and research documents in the office. Humans and
					AI use the same role permissions to upload and read them.
				</p>
			</header>
			<div
				role="tablist"
				aria-label="File views"
				className="tabs tabs-border w-fit"
				onKeyDown={(event) => {
					if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
						return;
					event.preventDefault();
					const next =
						event.key === "Home"
							? "files"
							: event.key === "End"
								? "gallery"
								: tab === "files"
									? "gallery"
									: "files";
					setTab(next);
					event.currentTarget
						.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)
						?.focus();
				}}
			>
				<button
					type="button"
					role="tab"
					id={`${fieldId}-files-tab`}
					data-view="files"
					tabIndex={tab === "files" ? 0 : -1}
					aria-controls={`${fieldId}-panel`}
					aria-selected={tab === "files"}
					className={`tab ${tab === "files" ? "tab-active" : ""}`}
					onClick={() => setTab("files")}
				>
					Files
				</button>
				<button
					type="button"
					role="tab"
					id={`${fieldId}-gallery-tab`}
					data-view="gallery"
					tabIndex={tab === "gallery" ? 0 : -1}
					aria-controls={`${fieldId}-panel`}
					aria-selected={tab === "gallery"}
					className={`tab ${tab === "gallery" ? "tab-active" : ""}`}
					onClick={() => setTab("gallery")}
				>
					Gallery
				</button>
			</div>
			{tab === "gallery" ? (
				<div
					id={`${fieldId}-panel`}
					role="tabpanel"
					aria-labelledby={`${fieldId}-gallery-tab`}
				>
					<ImageGallery
						workspace={workspace}
						onUpload={() => setTab("files")}
					/>
				</div>
			) : (
				<section
					id={`${fieldId}-panel`}
					role="tabpanel"
					aria-labelledby={`${fieldId}-files-tab`}
					className="card border border-base-300 bg-base-100 shadow-sm"
				>
					<div className="card-body gap-5">
						<div className="flex flex-wrap items-end gap-4">
							<label className="form-control min-w-44">
								<span className="label-text mb-2 font-medium">
									File category
								</span>
								<select
									className="select select-bordered"
									value={module}
									onChange={(event) => {
										setModule(event.target.value);
										setRecordId("");
										setPendingDelete("");
										setError("");
										setNotice("");
									}}
								>
									{modules.map((module) => (
										<option key={module} value={module}>
											{module === "projects" ? "Projects" : "Reports"}
										</option>
									))}
								</select>
							</label>
							{module === "projects" && (
								<label className="form-control min-w-52">
									<span className="label-text mb-2 font-medium">Project</span>
									<select
										className="select select-bordered"
										value={recordId}
										onChange={(event) => {
											setRecordId(event.target.value);
											setPendingDelete("");
										}}
									>
										<option value="">All project files</option>
										{workspace.projects.map((project) => (
											<option key={project.id} value={project.id}>
												{project.name}
											</option>
										))}
									</select>
								</label>
							)}
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								disabled={query.isFetching}
								onClick={() => void query.refetch()}
							>
								Refresh files
							</button>
						</div>
						{query.error && (
							<p role="alert" className="text-sm text-error">
								{query.error.message}
							</p>
						)}
						{query.data && !query.data.storageConfigured && (
							<div role="status" className="alert alert-info">
								<span>
									File storage is not configured yet. An operator must configure
									private S3-compatible storage before uploads are available.
								</span>
							</div>
						)}
						{canWrite && query.data?.storageConfigured && (
							<form
								className="rounded-box border border-dashed border-base-300 bg-base-200/50 p-4"
								onSubmit={upload}
							>
								<label
									htmlFor={`${fieldId}-upload`}
									className="mb-2 block font-medium"
								>
									Upload{" "}
									{module === "projects" && recordId
										? "to this project"
										: "a file"}
								</label>
								<div className="flex flex-wrap items-center gap-3">
									<input
										key={inputKey}
										id={`${fieldId}-upload`}
										className="file-input file-input-bordered w-full max-w-md"
										type="file"
										disabled={busy}
										onChange={(event) =>
											setFile(event.target.files?.[0] || null)
										}
									/>
									<button
										type="submit"
										className="btn btn-primary"
										disabled={!file || busy}
									>
										{busy && (
											<span className="loading loading-spinner loading-xs" />
										)}
										Upload file
									</button>
								</div>
								<p className="mt-2 text-sm text-base-content/60">
									Up to 10 MiB per file. Downloads require an active office
									account. Files are kept separately from database backups.
								</p>
							</form>
						)}
						{error && (
							<p role="alert" className="text-sm text-error">
								{error}
							</p>
						)}
						{notice && (
							<p role="status" className="text-sm text-success">
								{notice}
							</p>
						)}
						{query.isPending ? (
							<p role="status" className="text-base-content/60">
								Loading files…
							</p>
						) : query.data?.files.length ? (
							<ul className="divide-y divide-base-300">
								{query.data.files.map((item) => (
									<li
										key={item.id}
										className="flex flex-wrap items-center justify-between gap-3 py-4"
									>
										<div className="min-w-0 flex-1">
											<p className="break-words font-medium">{item.name}</p>
											<p className="mt-1 text-sm text-base-content/60">
												{fileSize(item.sizeBytes)} ·{" "}
												{workspace.members.find(
													(member) => member.id === item.uploadedBy,
												)?.name || "Office member"}
												{item.recordId && module === "projects"
													? ` · ${workspace.projects.find((project) => project.id === item.recordId)?.name || "Linked project"}`
													: ""}
											</p>
										</div>
										<div className="flex flex-wrap items-center gap-2">
											<button
												type="button"
												className="btn btn-outline btn-sm"
												disabled={busy}
												onClick={() =>
													void run(() => downloadFile(item.id, item.name))
												}
											>
												Download
											</button>
											{canWrite &&
												(pendingDelete === item.id ? (
													<>
														<button
															type="button"
															className="btn btn-error btn-sm"
															disabled={busy}
															onClick={() =>
																void run(async () => {
																	await deleteFile(item.id, item.revision);
																	setPendingDelete("");
																	setNotice(
																		"File deleted from the office. Its history is retained.",
																	);
																	await queryClient.invalidateQueries({
																		queryKey: ["files"],
																	});
																})
															}
														>
															Confirm delete
														</button>
														<button
															type="button"
															className="btn btn-ghost btn-sm"
															onClick={() => setPendingDelete("")}
														>
															Cancel
														</button>
													</>
												) : (
													<button
														type="button"
														className="btn btn-ghost btn-sm text-error"
														disabled={busy}
														onClick={() => setPendingDelete(item.id)}
													>
														Delete
													</button>
												))}
										</div>
									</li>
								))}
							</ul>
						) : (
							!query.error && (
								<div className="rounded-box bg-base-200/50 p-8 text-center">
									<h2 className="font-semibold">No files here yet</h2>
									<p className="mt-2 text-sm text-base-content/60">
										{canWrite
											? "Upload a document, image or research source to share with your team."
											: "Files uploaded by your team will appear here."}
									</p>
								</div>
							)
						)}
					</div>
				</section>
			)}
		</div>
	);
}

export function ProfileUpload({
	memberId,
	currentFileId,
	onUploaded,
	onRemove,
}: {
	memberId: string;
	currentFileId?: string;
	onUploaded: (id: string) => Promise<void>;
	onRemove?: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [inputKey, setInputKey] = useState(0);
	const fieldId = useId();
	const [choosing, setChoosing] = useState(false);
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: ["files", "profile", memberId],
		queryFn: () => listFiles("profile", memberId),
		retry: false,
	});
	async function perform(action: () => Promise<void>, message: string) {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await action();
			setNotice(message);
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setBusy(false);
			setInputKey((key) => key + 1);
		}
	}
	return (
		<div className="mt-4 grid gap-2">
			{query.data?.storageConfigured && (
				<>
					<label htmlFor={`${fieldId}-picture`} className="font-medium">
						Upload profile picture
					</label>
					<input
						key={inputKey}
						id={`${fieldId}-picture`}
						className="file-input file-input-bordered w-full"
						type="file"
						accept="image/png,image/jpeg,image/webp"
						disabled={busy}
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (!file) return;
							void perform(async () => {
								if (file.size > 2 * 1024 * 1024)
									throw new Error("Profile pictures must be 2 MiB or smaller.");
								const id = await uploadFile(file, "profile");
								await queryClient.invalidateQueries({ queryKey: ["files"] });
								await onUploaded(id);
							}, "Profile picture saved.");
						}}
					/>
					<p className="text-xs text-base-content/60">
						PNG, JPEG or WebP, up to 2 MiB. Stored privately for your office.
					</p>
				</>
			)}
			<button
				type="button"
				className="btn btn-outline btn-sm w-fit"
				disabled={busy}
				aria-expanded={choosing}
				onClick={() => setChoosing((value) => !value)}
			>
				Choose existing picture
			</button>
			{choosing && (
				<section
					className="grid gap-3 rounded-box border border-base-300 p-3"
					aria-label="Your previous profile pictures"
				>
					<p className="text-sm text-base-content/60">
						Choose from your previous profile uploads.
					</p>
					{query.isPending ? (
						<p role="status">Loading pictures…</p>
					) : query.error ? (
						<div>
							<p role="alert" className="text-sm text-error">
								{query.error.message}
							</p>
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => void query.refetch()}
							>
								Retry pictures
							</button>
						</div>
					) : query.data?.files.some(
							(item) => item.uploadedBy === memberId && isGalleryImage(item),
						) ? (
						<ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
							{query.data.files
								.filter(
									(item) =>
										item.uploadedBy === memberId && isGalleryImage(item),
								)
								.map((item) => (
									<li key={item.id} className="min-w-0">
										<div className="overflow-hidden rounded-box">
											<FileImage key={item.id} id={item.id} name={item.name} />
										</div>
										<p className="mt-1 truncate text-xs" title={item.name}>
											{item.name}
										</p>
										{currentFileId === item.id ? (
											<p className="mt-2 text-sm font-medium">
												Current picture
											</p>
										) : (
											<button
												type="button"
												className="btn btn-outline btn-sm mt-2 w-full"
												disabled={busy}
												aria-label={`Use ${item.name}`}
												onClick={() =>
													void perform(async () => {
														await onUploaded(item.id);
														setChoosing(false);
													}, "Profile picture saved.")
												}
											>
												Use picture
											</button>
										)}
									</li>
								))}
						</ul>
					) : (
						<p className="text-sm text-base-content/60">
							No previous pictures. Upload a profile picture to reuse it here.
						</p>
					)}
				</section>
			)}
			{onRemove && (
				<button
					type="button"
					className="btn btn-ghost btn-sm w-fit"
					disabled={busy}
					onClick={() => void perform(onRemove, "Profile picture removed.")}
				>
					Remove uploaded picture
				</button>
			)}
			{busy && (
				<p role="status" className="text-sm text-base-content/60">
					Saving picture…
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-error">
					{error}
				</p>
			)}
			{notice && (
				<p role="status" className="text-sm text-success">
					{notice}
				</p>
			)}
		</div>
	);
}
