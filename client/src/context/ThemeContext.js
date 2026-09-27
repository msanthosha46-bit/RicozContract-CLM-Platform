import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const ThemeContext = createContext(null);

export const THEME_STORAGE_KEY = 'ricoz_theme';
export const THEMES = ['light', 'dark'];

const isTheme = (value) => THEMES.includes(value);

const readStoredTheme = () => {
	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		return isTheme(stored) ? stored : null;
	} catch (error) {
		return null;
	}
};

// First visit follows the operating system. After the user picks a theme their
// stored choice always wins, so it is never silently overridden again.
const systemTheme = () => {
	try {
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	} catch (error) {
		return 'light';
	}
};

const initialTheme = () => readStoredTheme() || systemTheme();

const applyTheme = (theme) => {
	if (typeof document === 'undefined') return;
	const root = document.documentElement;
	root.classList.toggle('dark', theme === 'dark');
	root.style.colorScheme = theme;
};

export const ThemeProvider = ({ children }) => {
	const [theme, setTheme] = useState(initialTheme);

	useEffect(() => {
		applyTheme(theme);
		try {
			localStorage.setItem(THEME_STORAGE_KEY, theme);
		} catch (error) {
			// A blocked or full storage must not break the toggle in-session.
		}
	}, [theme]);

	// Keep an un-persisted first visit in sync if the OS flips while it is open.
	useEffect(() => {
		if (readStoredTheme()) return undefined;
		let query;
		try {
			query = window.matchMedia('(prefers-color-scheme: dark)');
		} catch (error) {
			return undefined;
		}
		const handleChange = (event) => setTheme(event.matches ? 'dark' : 'light');
		if (typeof query.addEventListener !== 'function') return undefined;
		query.addEventListener('change', handleChange);
		return () => query.removeEventListener('change', handleChange);
	}, []);

	const toggleTheme = useCallback(() => {
		setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
	}, []);

	const value = useMemo(
		() => ({ theme, isDark: theme === 'dark', setTheme, toggleTheme }),
		[theme, toggleTheme]
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

// App.js mounts ThemeProvider at the root, so in the running app this always
// resolves. The fallback keeps a component safe to render in isolation
// (a test mounting a single component, or a storybook-style preview) instead
// of throwing during render.
const FALLBACK_THEME = {
	theme: 'light',
	isDark: false,
	setTheme: () => {},
	toggleTheme: () => {}
};

export const useTheme = () => useContext(ThemeContext) || FALLBACK_THEME;
