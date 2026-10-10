import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from '../../context/AuthContext';
import API from '../../services/api';
import { Bell, Flag, LogOut, Menu, Mail, Settings, User as UserIcon, X, CalendarClock, AlertTriangle, ShieldCheck, FileText, FilePen, Gavel } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';
import { canManage, isAdmin, initialsFor, roleLabel } from '../../utils/roles';
import { pruneSeenIds, readSeenIds, writeSeenIds } from '../../utils/notificationSeen';

// The path a notification points at decides the icon, so the five real
// sources (expiring contracts, overdue obligations, overdue milestones,
// pending approvals, contract amendments) are visually distinguishable at a
// glance. `approval` and `amendment` only ever arrive for Admin/Manager — the
// endpoint withholds them from Employees.
//
// The server reports both work-item types as `overdue`; the stable `id`
// prefix (`milestone-` vs `obligation-`) tells the two apart so each group
// carries its own heading and its own shortcut to the matching list page.
//
// `amendment-decision` is the requester's own outcome. It uses a different id
// prefix (`amendment-decision-`) rather than a different `type` alone, so a
// decision about your request is never confused with a request waiting on you,
// and the two can sit in the feed for the same contract at once.
//
// `other` is a safety net, not a sixth source: if a notification ever
// arrives without a recognised type it still renders rather than silently
// disappearing from the list.
const NOTIFICATION_META = {
	expiry: { icon: CalendarClock, tone: 'text-amber-600 dark:text-amber-400', group: 'Expiring soon' },
	obligation: { icon: AlertTriangle, tone: 'text-red-600 dark:text-red-400', group: 'Overdue obligations' },
	milestone: { icon: Flag, tone: 'text-red-600 dark:text-red-400', group: 'Overdue milestones' },
	approval: { icon: ShieldCheck, tone: 'text-[#d51d29] dark:text-[#ff8a90]', group: 'Pending approvals' },
	amendment: { icon: FilePen, tone: 'text-[#d51d29] dark:text-[#ff8a90]', group: 'Amendments to decide' },
	'amendment-decision': { icon: Gavel, tone: 'text-slate-600 dark:text-slate-300', group: 'Your amendment requests' },
	other: { icon: FileText, tone: 'text-slate-500 dark:text-slate-400', group: 'Updates' }
};

const NOTIFICATION_ORDER = ['expiry', 'obligation', 'milestone', 'approval', 'amendment', 'amendment-decision', 'other'];

const typeOf = (item) => {
	if (typeof item?.id === 'string' && item.id.startsWith('milestone-')) return 'milestone';
	if (item?.type === 'overdue') return 'obligation';
	return Object.prototype.hasOwnProperty.call(NOTIFICATION_META, item?.type) ? item.type : 'other';
};

// Short section label for the header, so it never has to render a path.
const SECTION_LABELS = [
	[/^\/dashboard/, 'Overview'],
	[/^\/contracts\/create/, 'New contract'],
	[/^\/contracts\/[^/]+\/edit/, 'Edit contract'],
	[/^\/contracts\/[^/]+/, 'Contract details'],
	[/^\/contracts/, 'Contracts'],
	[/^\/approvals/, 'Approvals'],
	[/^\/amendments/, 'Amendments'],
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
	const [notificationsError, setNotificationsError] = useState('');
	const [notificationsOpen, setNotificationsOpen] = useState(false);
	const [seenIds, setSeenIds] = useState(() => new Set(readSeenIds(user?._id)));
	const [announcement, setAnnouncement] = useState('');
	const [menuOpen, setMenuOpen] = useState(false);

	const notificationsRef = useRef(null);
	const menuRef = useRef(null);
	const menuTriggerRef = useRef(null);
	const itemsRef = useRef([]);
	const activeRef = useRef(true);
	const firstAnnouncementRef = useRef(true);

	const userId = user?._id;

	const panelId = 'topbar-notifications';
	const menuId = 'topbar-account-menu';

	// A failed fetch used to be silently swallowed; the bell stayed quiet and
	// the panel hid the failure from the person it belonged to. Now the error
	// surfaces in the panel with a Retry so recovery does not demand a reload.
	const loadNotifications = useCallback(async () => {
		setNotificationsLoading(true);
		setNotificationsError('');
		try {
			const { data } = await API.get('/notifications');
			if (!activeRef.current) return;
			const loaded = Array.isArray(data?.items) ? data.items : [];
			const items = loaded.filter((item) => item && item.id);
			itemsRef.current = items;
			setNotifications({ count: Number(data?.count) || 0, items });
			if (userId) {
				// Drop seen ids that no longer exist in the feed and rebuild the
				// set from that, so anything brand-new stays unread.
				const kept = pruneSeenIds(userId, items.map((item) => item.id));
				setSeenIds(new Set(kept));
			}
		} catch (error) {
			if (!activeRef.current) return;
			setNotificationsError('Notifications could not be loaded.');
		} finally {
			if (activeRef.current) setNotificationsLoading(false);
		}
	}, [userId]);

	useEffect(() => {
		loadNotifications();
	}, [loadNotifications]);

	useEffect(() => {
		return () => {
			activeRef.current = false;
		};
	}, []);

	// Seen state is stored under the signed-in user's id, so switching users
	// on a shared browser must pull that user's own read state back in.
	useEffect(() => {
		setSeenIds(new Set(readSeenIds(userId)));
	}, [userId]);

	const items = notifications.items;
	const unreadItems = useMemo(() => items.filter((item) => !seenIds.has(item.id)), [items, seenIds]);
	const unreadCount = unreadItems.length;

	// Closing the panel is the act of reading it: every id on screen in that
	// session is marked seen, so the badge clears and the dots disappear.
	// Opening touches nothing, so an unread item stays visually unread for as
	// long as it is on screen, and anything that arrives after the close — a
	// retry, a refresh, a later fetch — keeps its id absent from the list and
	// stays unread until the panel is opened and closed again.
	useEffect(() => {
		if (notificationsOpen || !userId) return;
		const liveIds = itemsRef.current.map((item) => item.id).filter(Boolean);
		if (!liveIds.length) return;
		setSeenIds((prev) => {
			const merged = new Set(prev);
			let changed = false;
			for (const id of liveIds) {
				if (!merged.has(id)) {
					merged.add(id);
					changed = true;
				}
			}
			if (changed) writeSeenIds(userId, [...merged]);
			return changed ? merged : prev;
		});
	}, [notificationsOpen, userId]);

	// A polite live region announces count changes as they happen, but a fresh
	// page load is not an event worth narrating — the first render is skipped.
	useEffect(() => {
		if (firstAnnouncementRef.current) {
			firstAnnouncementRef.current = false;
			return;
		}
		setAnnouncement(
			unreadCount > 0
				? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
				: 'No unread notifications'
		);
	}, [unreadCount]);

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
	// notifications and nothing else. Overdue obligations and overdue
	// milestones each get their own shortcut, so a milestone-only feed no
	// longer steers the user to the obligations page.
	const shortcuts = useMemo(() => {
		const targets = [];
		if (grouped.some((group) => group.type === 'expiry') && canManage(user?.role)) {
			targets.push({ label: 'Expiring contracts', href: '/renewals' });
		}
		if (grouped.some((group) => group.type === 'obligation')) {
			targets.push({ label: 'Overdue obligations', href: '/obligations' });
		}
		if (grouped.some((group) => group.type === 'milestone')) {
			targets.push({ label: 'Overdue milestones', href: '/milestones' });
		}
		if (grouped.some((group) => group.type === 'approval') && canManage(user?.role)) {
			targets.push({ label: 'Approval queue', href: '/approvals' });
		}
		if (grouped.some((group) => group.type === 'amendment') && canManage(user?.role)) {
			targets.push({ label: 'Amendment queue', href: '/amendments' });
		}
		return targets;
	}, [grouped, user?.role]);

	const goTo = (href) => {
		setNotificationsOpen(false);
		navigate(href);
	};

	// Following a notification both closes the panel and marks that one item
	// seen immediately; the open-marker already covered the rest on display.
	const openNotification = (item) => {
		setNotificationsOpen(false);
		if (userId && item.id) {
			setSeenIds((prev) => {
				if (prev.has(item.id)) return prev;
				const next = new Set(prev);
				next.add(item.id);
				writeSeenIds(userId, [...next]);
				return next;
			});
		}
		navigate(item.href);
	};

	const bellLabel = unreadCount > 0
		? `Notifications: ${unreadCount} unread`
		: 'Notifications';

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
								className="fixed right-4 top-16 z-50 mt-2 max-h-[calc(100vh_-_5rem)] w-[min(19rem,calc(100vw_-_2rem))] origin-top-right overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-2 text-left shadow-xl dark:border-slate-700 dark:bg-[#1a2436] sm:top-20 md:absolute md:right-0 md:top-auto"
							>
								<div className="flex items-center gap-3 rounded-xl px-2 py-2">
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

								<span className="mx-2 mb-1 block rounded-full bg-[#fff0f0] px-2.5 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-[#d51d29] dark:bg-[#d51d29]/15 dark:text-[#ff8a90]">
									{roleLabel(user?.role)}
								</span>

								<div className="my-0.5 h-px bg-slate-200 dark:bg-slate-700" />

								<Link
									role="menuitem"
									to="/profile"
									onClick={closeMenu}
									className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-[#243048]"
								>
									<UserIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> Profile
								</Link>

								{isAdmin(user?.role) && (
									<Link
										role="menuitem"
										to="/settings"
										onClick={closeMenu}
										className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-[#243048]"
									>
										<Settings className="h-4 w-4 shrink-0" aria-hidden="true" /> Settings
									</Link>
								)}

								{/* Phone-only: the header cannot fit these two inline. */}
								<div className="md:hidden">
									<ThemeToggle variant="solid" label />
								</div>

								<div className="my-0.5 h-px bg-slate-200 dark:bg-slate-700" />

								<button
									type="button"
									role="menuitem"
									onClick={handleLogout}
									className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-bold text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
								>
									<LogOut className="h-4 w-4 shrink-0" aria-hidden="true" /> Logout
								</button>
							</div>
						)}
					</div>

					<div ref={notificationsRef} className="relative">
						{/* Announce count changes to screen readers without stealing
						    focus; the bell's own label already carries the count. */}
						<span aria-live="polite" aria-atomic="true" className="sr-only">
							{announcement}
						</span>
						<button
							type="button"
							className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:bg-[#1a2436] dark:text-slate-300 dark:hover:bg-[#1e293b] dark:hover:text-white"
							title="Notifications"
							aria-label={bellLabel}
							aria-expanded={notificationsOpen}
							aria-haspopup="dialog"
							aria-controls={panelId}
							onClick={() => setNotificationsOpen((value) => !value)}
						>
							<Bell className="h-4 w-4" aria-hidden="true" />
							{unreadCount > 0 && (
								<span aria-hidden="true" className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#d51d29] px-1 text-[10px] font-bold text-white">
									{unreadCount}
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
								) : notificationsError && items.length === 0 ? (
									<div role="alert" className="px-2 py-6 text-center">
										<span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-500 dark:bg-red-500/10 dark:text-red-400">
											<AlertTriangle className="h-5 w-5" aria-hidden="true" />
										</span>
										<p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Could not load notifications</p>
										<p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{notificationsError}</p>
										<button
											type="button"
											onClick={loadNotifications}
											className="mt-3 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-[#d51d29] hover:text-[#d51d29] dark:border-slate-700 dark:text-slate-200 dark:hover:border-[#ff8a90] dark:hover:text-[#ff8a90]"
										>
											Retry
										</button>
									</div>
								) : items.length === 0 ? (
									<div className="px-2 py-6 text-center">
										<span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-700 dark:text-slate-300">
											<Bell className="h-5 w-5" aria-hidden="true" />
										</span>
										<p className="text-sm font-semibold text-slate-700 dark:text-slate-200">You are caught up</p>
									<p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
										No expiring contracts, overdue items, pending approvals or amendment decisions.
									</p>

									</div>
								) : (
									<>
										{notificationsError && (
											<div role="alert" className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
												<span>Notifications could not be refreshed.</span>
												<button
													type="button"
													onClick={loadNotifications}
													className="shrink-0 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 dark:border-red-400/40 dark:text-red-300 dark:hover:bg-red-500/20"
												>
													Retry
												</button>
											</div>
										)}
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
															const unread = !seenIds.has(item.id);
															return (
																<Link
																	key={item.id}
																	to={item.href}
																	onClick={() => openNotification(item)}
																	className="relative flex gap-2.5 rounded-xl px-2 py-2 transition hover:bg-slate-50 dark:hover:bg-[#243048]"
																>
																	<Icon className={`mt-0.5 h-4 w-4 shrink-0 ${meta.tone}`} aria-hidden="true" />
																	<span className="min-w-0 flex-1">
																		<span className={`block truncate text-sm ${unread ? 'font-bold text-slate-900 dark:text-white' : 'font-semibold text-slate-800 dark:text-slate-100'}`}>
																			{item.title}
																		</span>
																		<span className="block truncate text-xs text-slate-500 dark:text-slate-400">
																			{item.detail}
																		</span>
																	</span>
																	{unread && (
																		<span
																			data-unread="true"
																			aria-hidden="true"
																			className="absolute right-2 top-2 h-2 w-2 shrink-0 rounded-full bg-[#d51d29] dark:bg-[#ff8a90]"
																		/>
																	)}
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
