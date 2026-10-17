import { useSourceAnchor } from "./SourceLink";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import {
	decideReportReview,
	listReportReviews,
	requestReportReview,
	type Member,
	type Report,
} from "./api";

export default function ReportReviews({
	report,
	members,
	currentUser,
	canEdit,
}: {
	report: Report;
	members: Member[];
	currentUser: Member;
	canEdit: boolean;
}) {
	const cache = useQueryClient();
	const reviewerFieldId = useId();
	const [reviewer, setReviewer] = useState("");
	const [note, setNote] = useState("");
	const attempt = useRef<{ payload: string; id: string } | null>(null);
	const query = useQuery({
		queryKey: ["report-reviews", report.id],
		queryFn: () => listReportReviews(report.id),
		retry: false,
	});
	const refresh = async () => {
		await Promise.all([
			cache.invalidateQueries({ queryKey: ["report-reviews", report.id] }),
			cache.invalidateQueries({ queryKey: ["notifications"] }),
		]);
	};
	const request = useMutation({
		mutationFn: () => {
			const payload = JSON.stringify([
				report.id,
				report.revision,
				reviewer,
				note,
			]);
			if (attempt.current?.payload !== payload)
				attempt.current = { payload, id: crypto.randomUUID() };
			return requestReportReview(
				report.id,
				report.revision,
				[reviewer],
				attempt.current.id,
				note.trim(),
			);
		},
		onSuccess: async () => {
			setReviewer("");
			setNote("");
			attempt.current = null;
			await refresh();
		},
	});
	const decision = useMutation({
		mutationFn: ({
			id,
			revision,
			status,
		}: {
			id: string;
			revision: number;
			status: string;
		}) => decideReportReview(id, revision, status, note.trim()),
		onSuccess: async () => {
			setNote("");
			await refresh();
		},
	});
	const busy = request.isPending || decision.isPending;
	useSourceAnchor(query.data);
	return (
		<section
			className="border-t border-base-300 mt-5 pt-5 grid gap-3"
			aria-label="Report review"
		>
			<div>
				<h3 className="font-semibold text-lg">Review decisions</h3>
				<p className="text-sm text-base-content/65">
					Decisions apply to the requested revision. Editing this report does
					not approve it.
				</p>
			</div>
			{query.isPending && <p role="status">Loading reviews…</p>}
			{query.isError && (
				<p role="alert" className="text-error">
					{query.error.message}{" "}
					<button className="link" onClick={() => void query.refetch()}>
						Retry
					</button>
				</p>
			)}
			<ul className="grid gap-3">
				{query.data?.reviews.map((review) => (
					<li
						key={review.id}
						id={`source-report_review-${review.id}`}
						className="rounded-box border border-base-300 p-3"
					>
						<div className="flex flex-wrap gap-2 items-center">
							<strong>
								{members.find((m) => m.id === review.reviewerId)?.name ||
									"Assigned reviewer"}
							</strong>
							<span
								className={`badge badge-sm ${review.status === "approved" ? "badge-success" : review.status === "changes_requested" ? "badge-error" : "badge-warning"}`}
							>
								{review.status.replaceAll("_", " ")}
							</span>
							<span className="text-sm">
								Revision {review.reportRevision}
								{review.reportRevision !== report.revision
									? " (earlier revision)"
									: ""}
							</span>
						</div>
						{review.note && (
							<p className="text-sm whitespace-pre-wrap mt-2">{review.note}</p>
						)}
						{review.status === "pending" &&
							(review.requesterId === currentUser.id ||
								["admin", "manager"].includes(currentUser.role)) && (
								<button
									className="btn btn-ghost btn-sm mt-2"
									disabled={busy}
									onClick={() =>
										decision.mutate({
											id: review.id,
											revision: review.revision,
											status: "cancelled",
										})
									}
								>
									Cancel review request
								</button>
							)}
						{review.status === "pending" &&
							review.reviewerId === currentUser.id && (
								<div className="flex flex-wrap gap-2 mt-3">
									<button
										className="btn btn-success btn-sm"
										disabled={busy}
										onClick={() =>
											decision.mutate({
												id: review.id,
												revision: review.revision,
												status: "approved",
											})
										}
									>
										Approve revision {review.reportRevision}
									</button>
									<button
										className="btn btn-outline btn-sm"
										disabled={busy}
										onClick={() =>
											decision.mutate({
												id: review.id,
												revision: review.revision,
												status: "changes_requested",
											})
										}
									>
										Request changes
									</button>
								</div>
							)}
					</li>
				))}
			</ul>
			{query.data?.reviews.length === 0 && (
				<p className="text-sm text-base-content/65">
					No review requested for this report.
				</p>
			)}
			{(canEdit ||
				query.data?.reviews.some(
					(r) => r.reviewerId === currentUser.id && r.status === "pending",
				)) && (
				<label className="grid gap-1 text-sm">
					Review note
					<textarea
						className="textarea textarea-bordered w-full"
						value={note}
						onChange={(event) => setNote(event.target.value)}
						disabled={busy}
						maxLength={2000}
					/>
				</label>
			)}
			{canEdit && (
				<form
					className="flex flex-wrap gap-2 items-end"
					onSubmit={(event) => {
						event.preventDefault();
						request.mutate();
					}}
				>
					<div className="grid gap-1 text-sm flex-1 min-w-40">
						<label htmlFor={reviewerFieldId}>Designated reviewer</label>
						<select
							id={reviewerFieldId}
							className="select select-bordered w-full"
							value={reviewer}
							onChange={(event) => setReviewer(event.target.value)}
							disabled={busy}
							required
						>
							<option value="">Choose reviewer</option>
							{members
								.filter(
									(m) =>
										m.status === "active" &&
										m.role !== "viewer" &&
										m.id !== currentUser.id &&
										m.id !== report.authorId,
								)
								.map((m) => (
									<option key={m.id} value={m.id}>
										{m.name}
										{m.kind === "agent" ? " (AI)" : ""}
									</option>
								))}
						</select>
					</div>
					<button className="btn btn-primary" disabled={busy || !reviewer}>
						Request review of revision {report.revision}
					</button>
				</form>
			)}
			{(request.isError || decision.isError) && (
				<p role="alert" className="text-error text-sm">
					{request.error?.message || decision.error?.message} Your note is
					preserved.
				</p>
			)}
		</section>
	);
}
