import React from 'react';

// A "nothing here yet" panel. Every list page replaces its bare
// "No records found." sentence with this so the state explains what would
// appear here and, where one exists, offers the action that creates it.
const EmptyState = ({ icon: Icon, title, description, action, compact = false }) => (
	<div
		className={`flex flex-col items-center justify-center text-center ${compact ? 'px-5 py-8' : 'px-5 py-14'}`}
	>
		{Icon && (
			<span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#fff0f0] text-[#d51d29] dark:bg-[#d51d29]/15 dark:text-[#ff8a90]">
				<Icon className="h-6 w-6" aria-hidden="true" />
			</span>
		)}
		<p className="text-base font-bold text-slate-800 dark:text-slate-100">{title}</p>
		{description && (
			<p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>
		)}
		{action && <div className="mt-5">{action}</div>}
	</div>
);

export default EmptyState;
