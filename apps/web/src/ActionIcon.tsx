import {
	AlertTriangle,
	Bell,
	CalendarClock,
	ChartNoAxesColumn,
	Check,
	Circle,
	ContactRound,
	Copy,
	Download,
	Files,
	FolderKanban,
	Image,
	Info,
	KeyRound,
	LayoutDashboard,
	LogOut,
	type LucideIcon,
	Menu,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	Settings,
	ShieldCheck,
	Sparkles,
	Trash2,
	Upload,
	Users,
	X,
} from "lucide-react";

const icons = {
	alert: AlertTriangle,
	bell: Bell,
	calendarClock: CalendarClock,
	chart: ChartNoAxesColumn,
	check: Check,
	contact: ContactRound,
	copy: Copy,
	dashboard: LayoutDashboard,
	download: Download,
	edit: Pencil,
	empty: Sparkles,
	files: Files,
	folderKanban: FolderKanban,
	image: Image,
	info: Info,
	key: KeyRound,
	logout: LogOut,
	menu: Menu,
	plus: Plus,
	refresh: RefreshCw,
	search: Search,
	settings: Settings,
	shield: ShieldCheck,
	status: Circle,
	trash: Trash2,
	upload: Upload,
	users: Users,
	close: X,
} satisfies Record<string, LucideIcon>;

export type ActionIconName = keyof typeof icons;

export default function ActionIcon({
	name,
	size = 18,
	className,
}: {
	name: ActionIconName;
	size?: number;
	className?: string;
}) {
	const Icon = icons[name];
	return (
		<Icon
			size={size}
			strokeWidth={1.75}
			className={className}
			style={{ flexShrink: 0 }}
			fill={name === "status" ? "currentColor" : "none"}
			aria-hidden="true"
			focusable="false"
		/>
	);
}
