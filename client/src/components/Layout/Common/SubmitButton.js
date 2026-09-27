import React from 'react';
import { LoaderCircle } from 'lucide-react';

// A submit button that owns its own busy state. While `loading` is true it
// spins, announces itself with aria-busy, and is `disabled` — which is what
// stops a double-tap or a repeated Enter key from firing the same request
// twice. Every form in the app routes its submit through this.
//
// The label stays mounted while busy (defaulting to the resting label) so
// the button does not collapse and shift the layout mid-request.
const SubmitButton = ({
	children,
	loading = false,
	loadingLabel,
	disabled = false,
	className = '',
	type = 'submit',
	...rest
}) => {
	const inert = loading || disabled;

	return (
		<button
			type={type}
			disabled={inert}
			aria-busy={loading || undefined}
			className={`inline-flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-70 ${className}`}
			{...rest}
		>
			{loading && <LoaderCircle className="ricoz-spin h-4 w-4 shrink-0" aria-hidden="true" />}
			<span>{loading ? loadingLabel || children : children}</span>
		</button>
	);
};

export default SubmitButton;
