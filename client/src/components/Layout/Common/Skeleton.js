import React from 'react';

// Loading placeholders. These use the `.ricoz-skeleton` shimmer, which reads
// the theme's surface tokens, and each is marked aria-hidden so a screen
// reader hears the loading status once (see PageSkeleton) rather than a
// list of meaningless empty boxes.

const bar = (className) => <div aria-hidden="true" className={`ricoz-skeleton rounded-lg ${className}`} />;

export const SkeletonText = ({ lines = 1, className = '' }) => (
	<>
		{Array.from({ length: lines }, (_, index) => (
			<div key={index} aria-hidden="true">
				{bar(`h-3 ${index === lines - 1 ? 'w-2/3' : 'w-full'} ${index > 0 ? 'mt-2' : ''} ${className}`)}
			</div>
		))}
	</>
);

// A single row shaped like the tables the list pages render.
export const SkeletonRows = ({ rows = 6, columns = 5, className = '' }) => (
	<div className={className}>
		{Array.from({ length: rows }, (_, rowIndex) => (
			<div key={rowIndex} className="flex items-center gap-4 border-b border-slate-100 px-4 py-4 last:border-0">
				{Array.from({ length: columns }, (_, columnIndex) => (
					<div
						key={columnIndex}
						className={`ricoz-skeleton h-3 rounded-lg ${columnIndex === 0 ? 'w-24' : 'flex-1'}`}
					/>
				))}
			</div>
		))}
	</div>
);

export const SkeletonCard = ({ className = '' }) => (
	<div className={`rounded-2xl border border-slate-200 bg-white p-6 shadow-sm ${className}`}>
		<div className="flex items-start justify-between gap-4">
			{bar('h-3 w-28')}
			<div className="ricoz-skeleton h-10 w-10 rounded-xl" />
		</div>
		<div className="mt-6 space-y-2">
			{bar('h-7 w-32')}
			{bar('h-3 w-40')}
		</div>
	</div>
);

// Shared page frame for the list pages: heading block, filter row, table.
export const PageSkeleton = ({ cards = 0, rows = 6, columns = 5 }) => (
	<div className="space-y-7" role="status" aria-live="polite" aria-busy="true">
		<span className="sr-only">Loading…</span>

		<div className="space-y-3">
			{bar('h-3 w-32')}
			{bar('h-9 w-64 max-w-full')}
			{bar('h-3 w-full max-w-xl')}
		</div>

		{cards > 0 && (
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				{Array.from({ length: cards }, (_, index) => (
					<SkeletonCard key={index} />
				))}
			</div>
		)}

		<div className="overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm">
			<div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
				<div className="ricoz-skeleton h-10 flex-1 rounded-xl" />
				<div className="ricoz-skeleton h-10 w-32 rounded-xl" />
				<div className="ricoz-skeleton h-10 w-32 rounded-xl" />
			</div>
			<SkeletonRows rows={rows} columns={columns} />
		</div>
	</div>
);

export default PageSkeleton;
