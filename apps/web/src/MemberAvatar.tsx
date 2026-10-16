import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getFileBlob } from "./api";

const initials = (name: string) =>
	name
		.split(/\s+/)
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();

export default function MemberAvatar({
	name,
	avatarUrl: externalUrl,
	avatarFileId,
	className = "size-10",
}: {
	name: string;
	avatarUrl?: string;
	avatarFileId?: string;
	className?: string;
}) {
	const fileQuery = useQuery({
		queryKey: ["file-content", avatarFileId],
		queryFn: () => getFileBlob(avatarFileId || ""),
		enabled: !!avatarFileId,
		retry: false,
		staleTime: 60_000,
	});
	const [fileUrl, setFileUrl] = useState({ id: "", url: "" });
	useEffect(() => {
		if (!fileQuery.data) {
			setFileUrl({ id: "", url: "" });
			return;
		}
		const url = URL.createObjectURL(fileQuery.data);
		setFileUrl({ id: avatarFileId || "", url });
		return () => URL.revokeObjectURL(url);
	}, [fileQuery.data, avatarFileId]);
	const avatarUrl = avatarFileId
		? fileUrl.id === avatarFileId
			? fileUrl.url
			: ""
		: externalUrl;
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const failed = avatarUrl === failedUrl;
	return (
		<div className={`avatar ${!avatarUrl || failed ? "placeholder" : ""}`}>
			{avatarUrl && !failed ? (
				<img
					className={`${className} rounded-full object-cover`}
					src={avatarUrl}
					alt={`${name} avatar`}
					referrerPolicy="no-referrer"
					loading="lazy"
					onError={() => setFailedUrl(avatarUrl)}
					onLoad={() => setFailedUrl(null)}
				/>
			) : (
				<div
					role="img"
					className={`${className} rounded-full bg-secondary text-secondary-content`}
					aria-label={`${name} initials`}
				>
					<span aria-hidden="true">{initials(name)}</span>
				</div>
			)}
		</div>
	);
}
