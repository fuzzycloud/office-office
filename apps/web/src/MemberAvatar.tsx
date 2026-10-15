import { useState } from "react";

const initials = (name: string) =>
	name
		.split(/\s+/)
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();

export default function MemberAvatar({
	name,
	avatarUrl,
	className = "size-10",
}: {
	name: string;
	avatarUrl?: string;
	className?: string;
}) {
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
