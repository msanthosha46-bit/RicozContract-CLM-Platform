import React from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';

// The dark left-hand panel on the auth screens. `stats` are illustrative
// figures describing what the product does, not live data, so the copy names
// the product rather than quoting a total that would look like a report.
const AuthAside = ({ headline, stats }) => (
	<section className="hidden flex-col justify-between bg-[#0f1d3a] p-8 text-white md:flex lg:p-10">
		<div>
			<div className="flex items-center gap-3">
				<div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#d51d29] text-lg font-black text-white shadow-lg shadow-red-200">
					R
				</div>
				<div className="text-2xl font-black tracking-[-0.05em] text-white">RicozContract</div>
			</div>
			<div className="mt-10 space-y-4">
				<p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Contract lifecycle</p>
				<h2 className="text-3xl font-black leading-tight tracking-[-0.05em] lg:text-4xl">{headline}</h2>
			</div>
		</div>

		<div className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-5 shadow-inner shadow-slate-900/10">
			<div className="space-y-3 text-sm text-slate-200">
				{stats.map(([label, value]) => (
					<div key={label} className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2.5">
						<span className="min-w-0 truncate">{label}</span>
						<span className="shrink-0 font-semibold text-white">{value}</span>
					</div>
				))}
			</div>
		</div>
	</section>
);

// The shared frame for /login, /register, /forgot-password and
// /reset-password. It carries the brand, the theme switch and the optional
// left-hand panel, so all four auth screens stay on one system and all four
// are theme-aware.
const AuthLayout = ({ eyebrow, title, subtitle, aside, children, footer }) => (
	<div className="flex min-h-screen flex-col bg-[#f4f6f9] px-4 py-5 dark:bg-[#0b1220] sm:px-6 sm:py-8">
		<div className="mx-auto mb-5 flex w-full max-w-5xl items-center justify-between gap-3 sm:mb-7">
			<Link to="/" className="flex min-w-0 items-center gap-2.5">
				<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#d51d29] text-base font-black text-white shadow-lg shadow-red-200">
					R
				</span>
				<span className="min-w-0 truncate text-lg font-black tracking-[-0.04em] text-[#0f172a] dark:text-slate-100">
					Ricoz<span className="text-[#64748b] dark:text-slate-500">Contract</span>
				</span>
			</Link>
			<ThemeToggle />
		</div>

		<div className="flex flex-1 items-center justify-center">
			<div className="w-full max-w-5xl overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.08)] sm:rounded-[32px] dark:border-slate-700 dark:bg-[#141c2e]">
				<div className="grid md:grid-cols-[1.05fr_1fr]">
					{aside}

					<section className="p-6 sm:p-8 md:p-10 lg:p-12">
						<div className="mb-6 sm:mb-8">
							<p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d51d29] dark:text-[#ff8a90] sm:text-sm">
								{eyebrow}
							</p>
							<h1 className="mt-2.5 text-2xl font-black tracking-[-0.04em] text-[#0f172a] sm:mt-3 sm:text-3xl md:text-4xl dark:text-slate-50">
								{title}
							</h1>
							{subtitle && <p className="mt-2 text-sm text-[#475569] dark:text-slate-400">{subtitle}</p>}
						</div>

						{children}

						{footer && <div className="mt-6 text-center text-sm text-[#475569] dark:text-slate-400">{footer}</div>}
					</section>
				</div>
			</div>
		</div>
	</div>
);

const inputClass =
	'mt-2 w-full rounded-xl border border-[#dfe7f1] bg-[#f8fafc] px-3 py-3 text-[#0f172a] outline-none transition focus:border-[#d51d29] focus:bg-white focus:ring-4 focus:ring-red-100 dark:border-slate-600 dark:bg-[#1a2436] dark:text-slate-100 dark:focus:bg-[#1e293b]';

const labelClass = 'block text-sm font-medium text-[#334155] dark:text-slate-300';

export { AuthAside, inputClass, labelClass };
export default AuthLayout;
