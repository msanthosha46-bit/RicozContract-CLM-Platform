import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BellRing,
  CalendarClock,
  CheckCircle2,
  FileSignature,
  FileText,
  Flag,
  Lock,
  Menu,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Upload,
  UserCheck,
  X
} from 'lucide-react';
import ThemeToggle from '../components/Layout/ThemeToggle';

const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#security', label: 'Security' }
];

const FEATURES = [
  {
    icon: FileSignature,
    title: 'Contract records',
    text: 'Every agreement in one repository: type, counterparty, owner, value, currency, and start and end dates.'
  },
  {
    icon: UserCheck,
    title: 'Approval routing',
    text: 'Submit a draft for approval and let a manager or admin approve or reject it with a recorded comment.'
  },
  {
    icon: ScrollText,
    title: 'Obligations',
    text: 'Convert the promises inside a contract into owned, dated tasks with a due date and a status you can move.'
  },
  {
    icon: Flag,
    title: 'Milestones',
    text: 'Track delivery checkpoints alongside the contract so progress is visible to everyone who owns it.'
  },
  {
    icon: FileText,
    title: 'Documents',
    text: 'Attach the signed PDF or Word file to the contract. Each upload is versioned, checksummed and access-checked.'
  },
  {
    icon: CalendarClock,
    title: 'Renewals',
    text: 'See what is ending in 30, 60 and 90 days, then record a renewal with the old and new end date kept on file.'
  }
];

const STEPS = [
  {
    icon: FileText,
    title: 'Create the contract',
    text: 'Capture the commercial details. It starts as a draft and receives a contract number automatically.'
  },
  {
    icon: ShieldCheck,
    title: 'Route it for approval',
    text: 'Send it to a manager or admin. The contract holds at Pending Approval until a decision is recorded.'
  },
  {
    icon: BellRing,
    title: 'Track what comes next',
    text: 'Assign obligations and milestones, upload the signed document, and get alerted before the end date.'
  }
];

const SECURITY = [
  {
    icon: Lock,
    title: 'Hashed credentials',
    text: 'Passwords are stored as bcrypt hashes and never returned by the API. Failed sign-ins reveal nothing about which half was wrong.'
  },
  {
    icon: UserCheck,
    title: 'Role-based access',
    text: 'Admin, Manager and Employee see different navigation, and the server re-checks every request against the same rules.'
  },
  {
    icon: ScrollText,
    title: 'Scoped visibility',
    text: 'An Employee only sees contracts they created or were assigned, and only the obligations assigned to them.'
  },
  {
    icon: CheckCircle2,
    title: 'Auditable history',
    text: 'Creation, updates, approvals and status changes are written to an activity log with the acting user and time.'
  }
];

// The anchors the header and footer link to. Every id in this list is
// rendered below, and the test suite asserts the two stay in step, so a nav
// link can never point at a section that does not exist.
export const SECTION_IDS = NAV_LINKS.map((link) => link.href.replace('#', ''));

const LandingPage = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);

  // Close the mobile menu on a press outside, on Escape, and after following
  // an in-page link to a section. The hamburger counts as inside: `pointerdown`
  // reaches the document before the button's `click`, so treating the trigger
  // as an outside press would close the panel and then let that click toggle it
  // straight back open.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event) => {
      if (menuRef.current && menuRef.current.contains(event.target)) return;
      if (triggerRef.current && triggerRef.current.contains(event.target)) return;
      setMenuOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      setMenuOpen(false);
      if (triggerRef.current) triggerRef.current.focus();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    const targetId = window.location.hash.slice(1);
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;

    const scrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    target.scrollIntoView({ block: 'start' });
    document.documentElement.style.scrollBehavior = scrollBehavior;
  }, []);

  return (
    <div className="min-h-screen bg-[#f4f6f9] text-[#111827] dark:bg-[#0b1220] dark:text-slate-200">
      <a href="#main" className="ricoz-skip-link">Skip to content</a>

      <header className="sticky top-0 z-50 border-b border-[#e7ebf0] bg-white/90 backdrop-blur-xl dark:border-slate-700 dark:bg-[#101827]/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-4">
          {/* min-w-0 + truncate keeps the brand whole at 320px instead of
              clipping the second half of the wordmark. */}
          <Link to="/" className="group flex min-w-0 items-center gap-2.5 sm:gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#d51d29] text-base font-black text-white shadow-lg shadow-red-200 transition group-hover:bg-[#b91c26] sm:h-10 sm:w-10 sm:text-lg">
              R
            </span>
            <span className="min-w-0 truncate text-lg font-black leading-none tracking-[-0.04em] text-[#111827] sm:text-2xl dark:text-slate-100">
              Ricoz<span className="text-[#1f2a44] dark:text-slate-400">Contract</span>
            </span>
          </Link>

          {/* `#5f6e83` is this page's muted text value. It replaced
              `#64748b`, which clears 4.5:1 on white (4.76) but not on the
              `#f4f6f9` page tint the copy actually sits on, where it measured
              4.40. The replacement measures 4.80 there and 5.19 on the white
              cards. Every muted string on the page uses the same value so the
              header, hero, cards and footer cannot drift apart again. */}
          <nav aria-label="Sections" className="hidden items-center gap-9 text-sm font-bold text-[#5f6e83] md:flex dark:text-slate-400">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className="transition hover:text-[#0f172a] dark:hover:text-white">
                {link.label}
              </a>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />

            {/* On a phone the two CTAs and the nav do not fit on one row, so
                below md only the theme switch and the hamburger remain and the
                links move into a panel. */}
            <div className="hidden items-center gap-2 sm:flex">
              <Link
                to="/login"
                className="rounded-xl border border-[#d51d29] bg-white px-4 py-2.5 text-sm font-semibold text-[#d51d29] transition hover:bg-[#fff5f5] dark:border-[#d51d29]/40 dark:bg-transparent dark:text-[#ff8a90] dark:hover:bg-[#d51d29]/10 sm:px-5"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className="rounded-xl bg-[#d51d29] px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26] sm:px-5"
              >
                Start free
              </Link>
            </div>

            <button
              ref={triggerRef}
              type="button"
              onClick={() => setMenuOpen((value) => !value)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="landing-menu"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#dfe4ea] text-[#0f172a] transition hover:bg-[#f8fafc] dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800 md:hidden"
            >
              {menuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <div
            ref={menuRef}
            id="landing-menu"
            className="ricoz-fade border-t border-[#e7ebf0] bg-white px-4 pb-4 pt-2 dark:border-slate-700 dark:bg-[#101827] md:hidden"
          >
            <nav aria-label="Sections" className="flex flex-col">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-xl px-3 py-3 text-base font-semibold text-[#334155] transition hover:bg-[#f8fafc] dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {link.label}
                </a>
              ))}
            </nav>
            <div className="mt-2 flex flex-col gap-2 border-t border-[#eef1f5] pt-3 dark:border-slate-700 sm:hidden">
              <Link
                to="/login"
                onClick={() => setMenuOpen(false)}
                className="rounded-xl border border-[#d51d29] px-4 py-3 text-center text-sm font-semibold text-[#d51d29] transition hover:bg-[#fff5f5] dark:border-[#d51d29]/40 dark:bg-transparent dark:text-[#ff8a90] dark:hover:bg-[#d51d29]/10"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                onClick={() => setMenuOpen(false)}
                className="rounded-xl bg-[#d51d29] px-4 py-3 text-center text-sm font-semibold text-white transition hover:bg-[#b91c26]"
              >
                Start free
              </Link>
            </div>
          </div>
        )}
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-5 sm:pb-20 sm:pt-12 md:pt-14">
        <section className="text-center">
          <div className="ricoz-rise inline-flex items-center gap-2 rounded-full border border-[#f5cacc] bg-[#fff5f5] px-3.5 py-1.5 text-xs font-bold text-[#d51d29] shadow-sm sm:px-4 dark:border-[#d51d29]/30 dark:bg-[#d51d29]/10 dark:text-[#ff8a90]">
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Contract lifecycle management
          </div>

          {/* The heading steps down on the narrowest phones: text-5xl at 320px
              overflows the viewport before wrapping. */}
          <h1 className="ricoz-rise mx-auto mt-6 max-w-4xl text-[2.125rem] font-black leading-[1.08] tracking-[-0.045em] text-[#0f172a] sm:text-5xl sm:leading-[1.05] md:text-6xl lg:text-[68px] dark:text-slate-50">
            Every contract, obligation and renewal in one place.
          </h1>

          <p className="ricoz-rise mx-auto mt-5 max-w-2xl text-base leading-7 text-[#5f6e83] sm:text-[17px] md:text-[18px] dark:text-slate-400">
            RicozContract is a workspace for the whole contract lifecycle: record agreements, route
            them for approval, track the obligations and milestones they create, keep the signed
            documents attached, and get alerted before a renewal lapses.
          </p>

          <div className="ricoz-rise mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center sm:gap-4">
            <Link
              to="/register"
              className="group inline-flex items-center justify-center gap-2 rounded-xl bg-[#d51d29] px-6 py-3.5 text-sm font-bold text-white shadow-xl shadow-red-200 transition hover:bg-[#b91c26]"
            >
              Create your workspace
              <ArrowRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5 sm:h-5 sm:w-5" aria-hidden="true" />
            </Link>
            <Link
              to="/login"
              className="inline-flex items-center justify-center rounded-xl border border-[#d9e1ea] bg-white px-6 py-3.5 text-sm font-bold text-[#0f172a] shadow-sm transition hover:border-[#ccd7e3] hover:bg-[#f8fafc] dark:border-slate-600 dark:bg-[#1a2436] dark:text-slate-100 dark:hover:bg-[#1e293b]"
            >
              Sign in
            </Link>
          </div>

          {/* Product preview. The figures are labelled as an example so the
              page never implies live data. */}
          <div className="relative mx-auto mt-12 max-w-5xl overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white p-2.5 shadow-[0_22px_70px_rgba(15,23,42,0.08)] sm:rounded-[26px] sm:p-3 dark:border-slate-700 dark:bg-[#141c2e]">
            <div className="flex items-center justify-between rounded-xl border border-[#edf1f5] bg-[#f8fafc] px-3 py-2.5 text-left sm:rounded-[18px] sm:px-4 sm:py-3 dark:border-slate-700 dark:bg-[#1a2436]">
              <div className="flex items-center gap-2" aria-hidden="true">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444] sm:h-3 sm:w-3" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#f59e0b] sm:h-3 sm:w-3" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#22c55e] sm:h-3 sm:w-3" />
              </div>
              <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-[#5f6e83] sm:text-sm dark:text-slate-400">
                <span className="h-2 w-2 shrink-0 rounded-full bg-[#0f172a] dark:bg-slate-200" />
                <span className="truncate">RicozContract / Dashboard</span>
              </div>
            </div>

            <div className="mt-2 grid gap-2 overflow-hidden rounded-xl border border-[#e2e8f0] bg-gradient-to-br from-[#0f172a] via-[#182a45] to-[#111827] p-3 sm:mt-3 sm:rounded-[20px] sm:p-4 md:grid-cols-[1.05fr_1.95fr] dark:border-slate-700">
              <div className="flex flex-col justify-between rounded-xl bg-[#0b1220] p-4 text-white sm:rounded-[18px] sm:p-5">
                <div>
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#d51d29] text-xs font-black text-white sm:h-10 sm:w-10 sm:text-sm">
                      R
                    </div>
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400 sm:text-xs">Workspace</div>
                      <div className="truncate text-base font-bold sm:text-xl">RicozContract</div>
                    </div>
                  </div>
                  <div className="mt-5 rounded-xl bg-white/5 p-3.5 ring-1 ring-white/10 sm:mt-6 sm:rounded-2xl sm:p-4">
                    <div className="text-xs text-slate-300 sm:text-sm">Contracts tracked</div>
                    <div className="mt-1.5 text-2xl font-black sm:mt-3 sm:text-3xl">128</div>
                    <div className="mt-1.5 text-xs text-slate-400 sm:text-sm">Example workspace</div>
                  </div>
                </div>

                <div className="mt-5 space-y-2.5 text-xs text-slate-200 sm:mt-6 sm:space-y-3 sm:text-sm">
                  {[
                    ['Awaiting approval', '7'],
                    ['Expiring in 30 days', '4'],
                    ['Overdue obligations', '2']
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-2 rounded-xl bg-white/5 px-3 py-2">
                      <span className="truncate">{label}</span>
                      <span className="shrink-0 font-semibold text-white">{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl bg-[#f8fafc] p-4 sm:rounded-[18px] sm:p-5 md:p-6 dark:bg-[#162032]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#5f6e83] sm:text-sm dark:text-slate-400">Lifecycle stages</div>
                    <div className="mt-0.5 text-xl font-black text-[#0f172a] sm:mt-1 sm:text-2xl dark:text-slate-100">Contract pipeline</div>
                  </div>
                  <Link
                    to="/register"
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#d51d29] px-3 py-2 text-xs font-semibold text-white shadow-md shadow-red-100 transition hover:bg-[#b91c26] sm:px-4 sm:text-sm"
                  >
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Create
                  </Link>
                </div>

                <div className="mt-6 grid gap-3 sm:mt-8 sm:grid-cols-2 lg:grid-cols-3">
                  {FEATURES.slice(0, 3).map(({ icon: Icon, title, text }) => (
                    <div key={title} className="rounded-xl border border-[#e2e8f0] bg-white p-3.5 text-left shadow-sm sm:rounded-2xl sm:p-4 dark:border-slate-700 dark:bg-[#1a2436]">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#fff0f0] text-[#d51d29] sm:h-11 sm:w-11 dark:bg-[#d51d29]/15 dark:text-[#ff8a90]">
                        <Icon className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />
                      </div>
                      <div className="mt-3 text-xs font-semibold text-[#0f172a] sm:mt-4 sm:text-sm dark:text-slate-100">{title}</div>
                      <p className="mt-1.5 text-xs leading-5 text-[#475569] sm:text-sm sm:leading-6 dark:text-slate-400">{text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="mt-16 scroll-mt-24 sm:mt-20">
          <div className="flex flex-col items-center text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#d51d29] dark:text-[#ff8a90]">How it works</p>
            <h2 className="mt-3 text-2xl font-black tracking-[-0.04em] text-[#0f172a] sm:text-3xl md:text-4xl dark:text-slate-50">
              From draft to renewal, in three steps.
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-[#5f6e83] sm:text-base dark:text-slate-400">
              Each step maps to a screen in the app, and each one is recorded so the next person
              picking up the contract can see what happened.
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:mt-10 sm:grid-cols-2 sm:gap-5 md:grid-cols-3">
            {STEPS.map(({ icon: Icon, title, text }, index) => (
              <div
                key={title}
                className="relative rounded-2xl border border-[#e5e7eb] bg-white p-5 text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl dark:border-slate-700 dark:bg-[#141c2e] md:rounded-[28px]"
              >
                <div className="flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#fff0f0] text-[#d51d29] sm:h-12 sm:w-12 dark:bg-[#d51d29]/15 dark:text-[#ff8a90]">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  {/* The step number is real content rather than decoration, so
                      it has to clear 4.5:1 like every other piece of body copy.
                      `#94a3b8` measured 2.56:1 on the white card. The muted
                      value used across this page measures 5.19:1 there, and
                      slate-400 leaves the dark card on the 6.63:1 it already
                      rendered. */}
                  <span className="text-sm font-semibold text-[#5f6e83] dark:text-slate-400">0{index + 1}</span>
                </div>
                <h3 className="mt-4 text-lg font-bold text-[#0f172a] sm:mt-5 sm:text-xl dark:text-slate-100">{title}</h3>
                <p className="mt-2.5 text-sm leading-6 text-[#475569] sm:mt-3 sm:text-base sm:leading-7 dark:text-slate-400">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="mt-16 scroll-mt-24 sm:mt-20">
          <div className="flex flex-col items-center text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#d51d29] dark:text-[#ff8a90]">Features</p>
            <h2 className="mt-3 text-2xl font-black tracking-[-0.04em] text-[#0f172a] sm:text-3xl md:text-4xl dark:text-slate-50">
              Everything a contract needs, nothing it does not.
            </h2>
          </div>

          <div className="mt-8 grid gap-4 sm:mt-10 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <div
                key={title}
                className="rounded-2xl border border-[#e5e7eb] bg-white p-5 text-left shadow-sm transition hover:border-[#f2cfd1] dark:border-slate-700 dark:bg-[#141c2e] dark:hover:border-[#d51d29]/40"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#fff0f0] text-[#d51d29] sm:h-11 sm:w-11 dark:bg-[#d51d29]/15 dark:text-[#ff8a90]">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h3 className="mt-4 text-base font-bold text-[#0f172a] sm:text-lg dark:text-slate-100">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#475569] dark:text-slate-400">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="security" className="mt-16 scroll-mt-24 sm:mt-20">
          <div className="overflow-hidden rounded-2xl bg-[#0f172a] p-5 sm:rounded-[30px] sm:p-8 md:p-10">
            <div className="flex flex-col items-center text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#ff8a90]">Security</p>
              <h2 className="mt-3 text-2xl font-black tracking-[-0.04em] text-white sm:text-3xl md:text-4xl">
                Access is decided on the server, not in the browser.
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base dark:text-slate-400">
                Hiding a menu item is a convenience. Every request is re-authorised against your
                role on the API, so the rules hold even for a direct call.
              </p>
            </div>

            <div className="mt-8 grid gap-3 sm:mt-10 sm:grid-cols-2 sm:gap-4">
              {SECURITY.map(({ icon: Icon, title, text }) => (
                <div key={title} className="rounded-2xl border border-white/10 bg-white/5 p-4 text-left transition hover:border-[#ff8a90]/40 sm:p-5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 text-[#ff8a90] sm:h-10 sm:w-10">
                    <Icon className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-3.5 text-base font-bold text-white">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-300">{text}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
              <Link
                to="/register"
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-[#d51d29] px-6 py-3.5 text-sm font-bold text-white shadow-xl shadow-red-900/30 transition hover:bg-[#b91c26]"
              >
                Create your workspace
                <ArrowRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
              <Link
                to="/login"
                className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/5 px-6 py-3.5 text-sm font-bold text-white transition hover:bg-white/10"
              >
                Sign in
              </Link>
            </div>
          </div>
        </section>

        <section className="mt-16 sm:mt-20">
          <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
            {[
              { icon: Upload, text: 'Versioned document uploads with content-type validation' },
              { icon: RefreshCw, text: 'Renewal history that keeps the old and new end date' },
              { icon: CalendarClock, text: 'Contracts automatically marked Expired past their end date' }
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-start gap-3 rounded-2xl border border-[#e5e7eb] bg-white p-4 text-sm text-[#334155] shadow-sm dark:border-slate-700 dark:bg-[#141c2e] dark:text-slate-300">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#fff0f0] text-[#d51d29] dark:bg-[#d51d29]/15 dark:text-[#ff8a90]">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="pt-1.5 leading-6">{text}</span>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-[#e7ebf0] py-8 dark:border-slate-700">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 text-center sm:flex-row sm:justify-between sm:px-5 sm:text-left">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#d51d29] text-sm font-black text-white">
              R
            </span>
            <span className="min-w-0 truncate text-sm font-bold text-[#0f172a] dark:text-slate-100">
              Ricoz<span className="text-[#5f6e83] dark:text-slate-400">Contract</span>
            </span>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm font-medium text-[#5f6e83] dark:text-slate-400">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className="transition hover:text-[#0f172a] dark:hover:text-white">
                {link.label}
              </a>
            ))}
            <Link to="/login" className="transition hover:text-[#0f172a] dark:hover:text-white">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
