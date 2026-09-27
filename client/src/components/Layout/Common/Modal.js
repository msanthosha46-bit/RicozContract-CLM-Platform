import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const Modal = ({ isOpen, onClose, title, children, footer }) => {
	const panelRef = useRef(null);
	const restoreRef = useRef(null);

	useEffect(() => {
		if (!isOpen) return undefined;

		restoreRef.current = document.activeElement;

		const handleEscape = (event) => {
			if (event.key === 'Escape' || event.key === 'Esc') onClose();
		};

		// Tab is kept inside the dialog so focus cannot wander to the page
		// behind it, which is still rendered and still focusable.
		const handleTab = (event) => {
			if (event.key !== 'Tab' || !panelRef.current) return;
			const items = [...panelRef.current.querySelectorAll(FOCUSABLE)];
			if (!items.length) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};

		document.addEventListener('keydown', handleEscape);
		document.addEventListener('keydown', handleTab);

		const timer = setTimeout(() => {
			if (panelRef.current) {
				const target = panelRef.current.querySelector(FOCUSABLE) || panelRef.current;
				target.focus();
			}
		}, 0);

		return () => {
			clearTimeout(timer);
			document.removeEventListener('keydown', handleEscape);
			document.removeEventListener('keydown', handleTab);
			const previous = restoreRef.current;
			if (previous && typeof previous.focus === 'function') previous.focus();
		};
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0f172a]/60 px-0 backdrop-blur-sm sm:items-center sm:px-4">
			{/* Clicking the backdrop closes. The panel stops propagation so a
			    click inside it does not. */}
			<button
				type="button"
				aria-label="Close dialog"
				tabIndex={-1}
				onClick={onClose}
				className="absolute inset-0 h-full w-full cursor-default"
			/>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-label={typeof title === 'string' ? title : undefined}
				tabIndex={-1}
				className="relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-2xl outline-none dark:border-slate-700 dark:bg-[#141c2e] sm:mx-0 sm:max-h-[88vh] sm:rounded-[26px]"
			>
				<div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 p-4 dark:border-slate-700 sm:p-6">
					<h3 className="min-w-0 flex-1 text-base font-bold text-slate-800 sm:text-lg dark:text-slate-100">{title}</h3>
					<button
						type="button"
						aria-label="Close dialog"
						onClick={onClose}
						className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>

				{/* The body scrolls on its own so a long form never pushes the
				    footer actions off a short screen. */}
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 text-sm text-slate-600 sm:p-6 dark:text-slate-300">
					{children}
				</div>

				{footer && (
					/* `flex-col` on a phone puts the primary action (the last
					    child) at the bottom, within thumb reach. */
					<div className="flex shrink-0 flex-col gap-2 border-t border-slate-200 p-4 dark:border-slate-700 sm:flex-row sm:justify-end sm:gap-3 sm:p-6">
						{footer}
					</div>
				)}
			</div>
		</div>
	);
};

export default Modal;
