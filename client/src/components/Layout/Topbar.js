import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from '../../context/AuthContext';
import API from '../../services/api';
import { Bell, LogOut, Menu, Mail, Settings, User as UserIcon, X, CalendarClock, AlertTriangle, ShieldCheck, FileText } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';
import { canManage, isAdmin, initialsFor, roleLabel } from '../../utils/roles';

// The path a notification points at decides the icon, so the three real
// sources (expiring contracts, overdue obligations, pending approvals) are
// visually distinguishable at a glance. `approval` only ever arrives for
// Admin/Manager — the endpoint withholds it from Employees.
//
// `other` is a safety net, not a fourth source: if a notification ever
// arrives without a recognised type it still renders rather than silently
// disappearing from the list.
const NOTIFICATION_META = {
	expiry: { icon: CalendarClock, tone: 'text-amber-600 dark:text-amber-400', group: 'Expiring soon' },
	overdue: { icon: AlertTriangle, tone: 'text-red-600 dark:text-red-400', group: 'Overdue obligations' },
	approval: { icon: ShieldCheck, tone: 'text-[#d51d29] dark:text-[#ff8a90]', group: 'Pending approvals' },
	other: { icon: FileText, tone: 'text-slate-500 dark:text-slate-400', group: 'Updates' }
};

const NOTIFICATION_ORDER = ['expiry', 'overdue', 'approval', 'other'];

const typeOf = (item) => (Object.prototype.hasOwnProperty.call(NOTIFICATION_META, item?.type) ? item.type : 'other');

// Short section label for the header, so it never has to render a path.
const SECTION_LABELS = [
	[/^\/dashboard/, 'Overview'],
	[/^\/contracts\/create/, 'New contract'],
	[/^\/contracts\/[^/]+\/edit/, 'Edit contract'],
	[/^\/contracts\/[^/]+/, 'Contract details'],
	[/^\/contracts/, 'Contracts'],
	[/^\/approvals/, 'Approvals'],
	[/^\/obligations/, 'Obligations'],
	[/^\/milestones/, 'Milestones'],
	[/^\/renewals/, 'Renewals'],
	[/^\/reports/, 'Reports'],
	[/^\/activity/, 'Activity log'],
	[/^\/users/, 'User management'],
	[/^\/settings/, 'Settings'],
	[/^\/profile/, 'Profile']
];

const sectionLabel = (pathname) => {
	const match = SECTION_LABELS.find(([pattern]) => pattern.test(pathname));
	return match ? match[1] : 'Workspace';
};

const Topbar = ({ onMenuClick }) => {
	const { user, logout } = useContext(AuthContext);
	const location = useLocation();
	const navigate = useNavigate();

	const [notifications, setNotifications] = useState({ count: 0, items: [] });
	const [notificationsLoading, setNotificationsLoading] = useState(true);
	const [notificationsOpen, setNotificationsOpen] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);

	const notificationsRef = useRef(null);
	const menuRef = useRef(null);
	const menuTriggerRef = useRef(null);

	const panelId = 'topbar-notifications';
	const menuId = 'topbar-account-menu';

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const { data } = await API.get('/notifications');
				if (!active) return;
				setNotifications({
					count: Number(data?.count) || 0,
					items: Array.isArray(data?.items) ? data.items : []
				});
			} catch (error) {
				// A failed fetch is not a notification problem; keep the bell
				// usable and quiet rather than surfacing a fabricated error.
				if (active) setNotifications({ count: 0, items: [] });
			} finally {
				if (active) setNotificationsLoading(false);
			}
		};
		load();
		return () => {
			active = false;
		};
	}, []);

	// One document-level listener closes whichever overlay is open, so a press
	// outside dismisses both the notification popup and the account menu.
	useEffect(() => {
		const handlePointerDown = (event) => {
			const target = event.target;
			if (notificationsOpen && notificationsRef.current && !notificationsRef.current.contains(target)) {
				setNotificationsOpen(false);
			}
			if (menuOpen && menuRef.current && !menuRef.current.contains(target)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener('pointerdown', handlePointerDown);
		return () => document.removeEventListener('pointerdown', handlePointerDown);
	}, [notificationsOpen, menuOpen]);

	useEffect(() => {
		const handleKeyDown = (event) => {
			if (event.key !== 'Escape' && event.key !== 'Esc') return;
			if (notificationsOpen) setNotificationsOpen(false);
			if (menuOpen) {
				setMenuOpen(false);
				// Send focus back to the trigger so keyboard users do not lose
				// their place after dismissing the menu.
				if (menuTriggerRef.current) menuTriggerRef.current.focus();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [notificationsOpen, menuOpen]);

	// Roving focus inside the account menu.
	const handleMenuKeyDown = (event) => {
		const items = menuRef.current ? [...menuRef.current.querySelectorAll('[role="menuitem"]')] : [];
		if (!items.length) return;
		const current = items.indexOf(document.activeElement);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			items[(current + 1 + items.length) % items.length].focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			items[(current - 1 + items.length) % items.length].focus();
		} else if (event.key === 'Home') {
			event.preventDefault();
			items[0].focus();
		} else if (event.key === 'End') {
			event.preventDefault();
			items[items.length - 1].focus();
		}
	};

	const closeMenu = useCallback(() => setMenuOpen(false), []);
	const handleLogout = useCallback(() => {
		closeMenu();
		logout();
	}, [closeMenu, logout]);

	const items = notifications.items;
	const grouped = useMemo(
		() =>
			NOTIFICATION_ORDER.map((type) => ({
				type,
				meta: NOTIFICATION_META[type],
				entries: items.filter((item) => typeOf(item) === type)
			})).filter((group) => group.entries.length > 0),
		[items]
	);

	// Shortcuts to the screens behind each notification group. They are
	// buttons rather than links so the panel contains exactly the real
	// notifications and nothing else.
	const shortcuts = useMemo(() => {
		const targets = [];
		if (grouped.some((group) => group.type === 'expiry') && canManage(user?.role)) {
			targets.push({ label: 'Expiring contracts', href: '/renewals' });
		}
		if (grouped.some((group) => group.type === 'overdue')) {
			targets.push({ label: 'Overdue obligations', href: '/obligations' });
		}
		if (grouped.some((group) => group.type === 'approval') && canManage(user?.role)) {
			targets.push({ label: 'Approval queue', href: '/approvals' });
		}
		return targets;
	}, [grouped, user?.role]);

	const goTo = (href) => {
		setNotificationsOpen(false);
		navigate(href);
	};

	const displayName = user?.name || user?.email || 'Signed in';

	return (
		<header className="sticky top-0 z-20 h-16 border-b border-slate-200 bg-white/95 px-4 backdrop-blur-sm dark:border-slate-700 dark:bg-[#141c2e]/95 sm:h-20 sm:px-5 md:px-8">
			<div className="flex h-full items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-1.5 sm:gap-3">
					<button
						type="button"
						aria-label="Open navigation"
						aria-controls="ricoz-sidebar"
						className="-ml-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 md:hidden"
						onClick={onMenuClick}
					>
						<Menu className="h-5 w-5" aria-hidden="true" />
					</button>

					{/* The breadcrumb trail only fits from sm up; below that the
					    single section label is all the header has room for. */}
					<div className="flex min-w-0 items-center gap-2 text-sm font-bold">
						<span className="hidden truncate rounded-full bg-[#fff0f0] px-3 py-1.5 text-[#d51d29] dark:bg-[#d51d29]/15 dark:text-[#ff8a90] lg:inline">
							Workspace
						</span>
						<span className="hidden shrink-0 text-slate-300 dark:text-slate-600 sm:inline" aria-hidden="true">/</span>
						<span className="min-w-0 truncate text-[#0f1d3a] dark:text-slate-100" title={sectionLabel(location.pathname)}>
							{sectionLabel(location.pathname)}
						</span>
					</div>
				</div>

				<div className="flex shrink-0 items-center gap-1 sm:gap-2">
					{/* Desktop keeps the theme switch and logout visible; on a phone
					    both move into the account menu so the header still fits. */}
					<ThemeToggle className="hidden md:inline-flex" />

					<div ref={menuRef} className="relative">
						<button
							ref={menuTriggerRef}
							type="button"
							onClick={() => setMenuOpen((value) => !value)}
							aria-label={`Account menu for ${displayName}`}
							aria-haspopup="menu"
							aria-expanded={menuOpen}
							aria-controls={menuId}
							className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:bg-[#1a2436] dark:text-slate-300 dark:hover:bg-[#1e293b] dark:hover:text-white"
						>
							{/* An icon rather than the full address: an email string
							    overflows a 320px header long before it fits. */}
							<Mail className="h-4 w-4" aria-hidden="true" />
						</button>

						{menuOpen && (
							<div
								id={menuId}
								role="menu"
								aria-label="Account"
								data-overlay="account-menu"
								onKeyDown={handleMenuKeyDown}
								className="absolute right-0 z-50 mt-2 w-[min(19rem,calc(100vw_-_2rem))] origin-top-right rounded-2xl border border-slate-200 bg-white p-2 text-left shadow-xl dark:border-slate-700 dark:bg-[#1a2436]"
							>
								<div className="flex items-center gap-3 rounded-xl px-2 py-2.5">
									<span
										aria-hidden="true"
										className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0f1d3a] text-xs font-black text-white"
									>
										{initialsFor(displayName)}
									</span>
									<span className="min-w-0">
										<span className="block truncate text-sm font-bold text-slate-800 dark:text-slate-100">
											{displayName}
										</span>
										<span className="block truncate text-xs text-slate-500 dark:text-slate-400">
											{user?.email}
										</span>
									</span>
								</div>

								<span className="mx-2 my-1 block rounded-full bg-[#fff0f0] px-2.5 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-[#d51d29] dark:bg-[#d51d29]/15 dark:text-[#ff8a90]">
									{roleLabel(user?.role)}
								</span>

								<div className="my-1 h-px bg-slate-200 dark:bg-slate-700" />

								<Link
									role="menuitem"
									to="/profile"
									onClick={closeMenu}
									className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-[#243048]"
								>
									<UserIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> Profile
								</Link>

								{isAdmin(user?.role) && (
									<Link
										role="menuitem"
										to="/settings"
										onClick={closeMenu}
										className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-[#243048]"
									>
										<Settings className="h-4 w-4 shrink-0" aria-hidden="true" /> Settings
									</Link>
								)}

								{/* Phone-only: the header cannot fit these two inline. */}
								<div className="md:hidden">
									<ThemeToggle variant="solid" className="w-full justify-start gap-2.5 px-2.5" />
								</div>

								<div className="my-1 h-px bg-slate-200 dark:bg-slate-700" />

								<button
									type="button"
									role="menuitem"
									onClick={handleLogout}
									className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-sm font-bold text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
								>
									<LogOut className="h-4 w-4 shrink-0" aria-hidden="true" /> Logout
								</button>
							</div>
						)}
					</div>

					<div ref={notificationsRef} className="relative">
						<button
							type="button"
							className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:bg-[#1a2436] dark:text-slate-300 dark:hover:bg-[#1e293b] dark:hover:text-white"
							title="Notifications"
							aria-label="Notifications"
							aria-expanded={notificationsOpen}
							aria-haspopup="dialog"
							aria-controls={panelId}
							onClick={() => setNotificationsOpen((value) => !value)}
						>
							<Bell className="h-4 w-4" aria-hidden="true" />
							{notifications.count > 0 && (
								<span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#d51d29] px-1 text-[10px] font-bold text-white">
									{notifications.count}
								</span>
							)}
						</button>
						{notificationsOpen && (
							<div
								id={panelId}
								role="dialog"
								aria-label="Notifications"
								data-overlay="notifications"
								className="absolute right-0 z-50 mt-2 w-[min(20rem,calc(100vw_-_2rem))] rounded-2xl border border-slate-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-[#1a2436]"
							>
								<div className="flex items-center justify-between gap-2 px-1 pb-2">
									<p className="text-xs font-bold uppercase tracking-wide text-slate-400">Notifications</p>
									<button
										type="button"
										aria-label="Close notifications"
										onClick={() => setNotificationsOpen(false)}
										className="-mr-1 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
									>
										<X className="h-4 w-4" aria-hidden="true" />
									</button>
								</div>

								{notificationsLoading ? (
									<div className="space-y-2 px-1 py-2" role="status" aria-busy="true">
										<span className="sr-only">Loading notifications…</span>
										{[0, 1, 2].map((row) => (
											<div key={row} className="flex gap-2.5">
												<div className="ricoz-skeleton h-4 w-4 shrink-0 rounded-full" aria-hidden="true" />
												<div className="flex-1 space-y-1.5">
													<div className="ricoz-skeleton h-3 w-3/4 rounded" aria-hidden="true" />
													<div className="ricoz-skeleton h-2.5 w-1/2 rounded" aria-hidden="true" />
												</div>
											</div>
										))}
									</div>
								) : items.length === 0 ? (
									<div className="px-2 py-6 text-center">
										<span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-700 dark:text-slate-300">
											<Bell className="h-5 w-5" aria-hidden="true" />
										</span>
										<p className="text-sm font-semibold text-slate-700 dark:text-slate-200">You are caught up</p>
										<p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
											No expiring contracts, overdue obligations or pending approvals.
										</p>
									</div>
								) : (
									<>
										<div className="max-h-80 space-y-3 overflow-y-auto">
											{grouped.map(({ type, meta, entries }) => (
												<div key={type}>
													<p className="px-2 pb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">
														{meta.group}
														<span className="ml-1.5 font-normal normal-case tracking-normal text-slate-400">
															{entries.length}
														</span>
													</p>
													<div className="space-y-1">
														{entries.map((item) => {
															const Icon = meta.icon;
															return (
																<Link
																	key={item.id}
																	to={item.href}
																	onClick={() => setNotificationsOpen(false)}
																	className="flex gap-2.5 rounded-xl px-2 py-2 transition hover:bg-slate-50 dark:hover:bg-[#243048]"
																>
																	<Icon className={`mt-0.5 h-4 w-4 shrink-0 ${meta.tone}`} aria-hidden="true" />
																	<span className="min-w-0">
																		<span className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
																			{item.title}
																		</span>
																		<span className="block truncate text-xs text-slate-500 dark:text-slate-400">
																			{item.detail}
																		</span>
																	</span>
																</Link>
															);
														})}
													</div>
												</div>
											))}
										</div>

										{shortcuts.length > 0 && (
											<div className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-200 pt-2 dark:border-slate-700">
												{shortcuts.map((shortcut) => (
													<button
														key={shortcut.href}
														type="button"
														onClick={() => goTo(shortcut.href)}
														className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#243048]"
													>
														<FileText className="h-3.5 w-3.5" aria-hidden="true" />
														{shortcut.label}
													</button>
												))}
											</div>
										)}
									</>
								)}
							</div>
						)}
					</div>

					<button
						type="button"
						className="hidden h-10 items-center gap-2 rounded-xl bg-[#d51d29] px-3 text-sm font-bold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26] sm:inline-flex md:px-4"
						onClick={logout}
					>
						<LogOut className="h-4 w-4" aria-hidden="true" />
						<span>Logout</span>
					</button>
				</div>
			</div>
		</header>
	);
};

export default Topbar;
