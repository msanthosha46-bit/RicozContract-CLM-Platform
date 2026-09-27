/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ['./src/**/*.{js,jsx,ts,tsx}'],
	// The theme is a deliberate user choice persisted in localStorage, so the
	// `dark` class on <html> is the source of truth rather than the OS setting.
	darkMode: 'class',
	theme: {
		extend: {
		fontFamily: {
			sans: ['Lato', 'ui-sans-serif', 'system-ui', 'sans-serif']
		}
	}
	},
	plugins: []
};
