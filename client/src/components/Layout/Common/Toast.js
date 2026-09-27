import React, { useEffect } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

const styles = {
	success: 'border-[#bbf7d0] bg-[#eaf8f1] text-[#15803d] dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300',
	error: 'border-[#fecdd3] bg-[#fff1f2] text-[#be123c] dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300',
	info: 'border-[#bfdbfe] bg-[#eaf1ff] text-[#1d4ed8] dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300'
};

const icons = {
	success: CheckCircle2,
	error: AlertCircle,
	info: Info
};

const Toast = ({ type = 'success', message, onClose }) => {
	useEffect(() => {
		if (!message) return undefined;
		const timer = setTimeout(() => onClose && onClose(), 4000);
		return () => clearTimeout(timer);
	}, [onClose, message]);

	const Icon = icons[type] || Info;

	return (
		<div
			role="status"
			aria-live="polite"
			data-overlay="toast"
			className={`fixed right-4 top-5 z-50 flex max-w-[min(24rem,calc(100vw_-_2rem))] items-center gap-3 rounded-xl border px-4 py-3 shadow-lg ${styles[type] || styles.info}`}
		>
			<div className="flex-shrink-0">
				<Icon className="h-4 w-4" aria-hidden="true" />
			</div>
			<div className="min-w-0 flex-1 text-sm font-medium break-words">{message}</div>
			<button
				type="button"
				aria-label="Dismiss notification"
				onClick={onClose}
				className="flex-shrink-0 rounded-md p-1 transition hover:bg-black/5 dark:hover:bg-white/10"
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</div>
	);
};

export default Toast;
