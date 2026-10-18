import type { Member } from "./api";

// A name is a notification target only after the author picks its stable ID.
// These helpers recognize text for warnings and search, never to add recipients.
export function mentionStarts(body: string) {
	return [...body.matchAll(/(^|[\s([{<"'“‘,:;!?])@/gu)].map(
		(match) => (match.index ?? 0) + match[1].length,
	);
}

export function emailRanges(body: string) {
	return [...body.matchAll(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/gu)].map(
		(match) => ({
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length,
		}),
	);
}

export function nameAtStart(text: string, members: Member[]) {
	const lower = text.toLocaleLowerCase();
	return members
		.filter((member) => {
			if (!member.name || !lower.startsWith(member.name.toLocaleLowerCase()))
				return false;
			const next = text[member.name.length];
			if (
				next &&
				[".", "'", "’"].includes(next) &&
				/[\p{L}\p{N}]/u.test(text[member.name.length + 1] || "")
			)
				return false;
			return !next || /[\s.,;:!?()[\]{}<>"'“”‘’]/u.test(next);
		})
		.sort((left, right) => right.name.length - left.name.length)[0];
}
