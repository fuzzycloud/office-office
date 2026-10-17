const paths = {
	bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
	close: "M6 6l12 12M18 6 6 18",
	trash: "M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6",
	edit: "m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5",
	download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
	upload: "M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5",
	refresh:
		"M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1",
	image: "M3 3h18v18H3V3Zm0 14 6-6 5 5 3-3 4 4M8 7h.01",
	check: "m5 12 4 4L19 6",
	plus: "M12 5v14M5 12h14",
	copy: "M9 9h12v12H9V9ZM15 9V3H3v12h6",
} as const;

export type ActionIconName = keyof typeof paths;

export default function ActionIcon({
	name,
	size = 18,
	className,
}: {
	name: ActionIconName;
	size?: number;
	className?: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			style={{ flexShrink: 0 }}
			aria-hidden="true"
			focusable="false"
		>
			<path d={paths[name]} />
		</svg>
	);
}
