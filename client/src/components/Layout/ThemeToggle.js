import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

// Light/dark switch. The pressed state is exposed as `aria-pressed` so a
// screen reader announces the current mode rather than just "button".
const ThemeToggle = ({ className = '', variant = 'ghost' }) => {
	const { isDark, toggleTheme } = useTheme();

	const shell =
		variant === 'solid'
			? 'border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900 dark:border-slate-600 dark:bg-[#243048] dark:text-slate-300 dark:hover:bg-[#2c3a52] dark:hover:text-white'
			: 'border border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200';

	return (
		<button
			type="button"
			onClick={toggleTheme}
			aria-pressed={isDark}
			aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
			title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
			className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${shell} ${className}`}
		>
			{isDark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
		</button>
	);
};

export default ThemeToggle;
