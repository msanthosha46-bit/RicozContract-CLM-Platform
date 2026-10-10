import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

// Light/dark switch. The pressed state is exposed as `aria-pressed` so a
// screen reader announces the current mode rather than just "button".
//
// `label` turns the square icon button into a compact labelled row for the
// mobile account menu, where an icon alone is easy to miss and the square
// `w-10` slot left dead space beside it. The default square is unchanged, so
// the header, auth and landing usages are untouched.
const ThemeToggle = ({ className = '', variant = 'ghost', label = false }) => {
	const { isDark, toggleTheme } = useTheme();

	const shell =
		variant === 'solid'
			? 'border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900 dark:border-slate-600 dark:bg-[#243048] dark:text-slate-300 dark:hover:bg-[#2c3a52] dark:hover:text-white'
			: 'border border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200';

	const sizing = label
		? 'h-9 w-full justify-start gap-2.5 px-2.5 text-sm font-medium'
		: 'h-10 w-10 justify-center';

	return (
		<button
			type="button"
			onClick={toggleTheme}
			aria-pressed={isDark}
			aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
			title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
			className={`inline-flex shrink-0 items-center rounded-xl transition-colors ${sizing} ${shell} ${className}`}
		>
			{isDark ? <Sun className="h-4 w-4 shrink-0" aria-hidden="true" /> : <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />}
			{label && <span className="truncate">{isDark ? 'Light mode' : 'Dark mode'}</span>}
		</button>
	);
};

export default ThemeToggle;
