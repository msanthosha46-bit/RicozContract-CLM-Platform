import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import API from '../services/api';
import SubmitButton from '../components/Layout/Common/SubmitButton';
import AuthLayout, { AuthAside, inputClass, labelClass } from '../components/Layout/AuthLayout';

const ForgotPassword = () => {
	const [email, setEmail] = useState('');
	const [error, setError] = useState('');
	const [success, setSuccess] = useState('');
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (event) => {
		event.preventDefault();
		if (loading) return;
		setError('');
		setSuccess('');
		setLoading(true);

		try {
			const { data } = await API.post('/auth/forgot-password', { email: email.trim() });
			setSuccess(data.message || 'If an account exists for that email, a password reset link has been sent.');
		} catch (requestError) {
			const response = requestError.response?.data;
			if (requestError.response?.status === 429) {
				setError(response?.message || 'Too many attempts. Please try again later.');
			} else {
				setError(response?.message || 'Unable to send the reset request. Please try again.');
			}
		} finally {
			setLoading(false);
		}
	};

	return (
		<AuthLayout
			eyebrow="RicozContract"
			title="Forgot password?"
			subtitle="Enter your registered email and we will send you a reset link."
			aside={
				<AuthAside
					headline="Reset your password securely."
					stats={[
						['Delivery', 'One-time email link'],
						['Link lifetime', 'Short, single use'],
						['After reset', 'Other sessions revoked']
					]}
				/>
			}
			footer={
				<>
					Remembered it?{' '}
					<Link to="/login" className="font-semibold text-[#d51d29] hover:text-[#b91c26] dark:text-[#ff8a90]">
						Back to sign in
					</Link>
				</>
			}
		>
			{error && (
				<div
					role="alert"
					className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
				>
					{error}
				</div>
			)}

			{success ? (
				<div
					role="status"
					className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300"
				>
					{success}
				</div>
			) : (
				<form onSubmit={handleSubmit} className="space-y-5">
					<label className={labelClass} htmlFor="forgot-email">
						Email address
						<input
							id="forgot-email"
							name="email"
							type="email"
							autoComplete="email"
							required
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							className={inputClass}
						/>
					</label>

					<SubmitButton
						loading={loading}
						loadingLabel="Sending…"
						className="w-full rounded-xl bg-[#d51d29] px-4 py-3.5 font-semibold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26]"
					>
						Send reset link
					</SubmitButton>
				</form>
			)}
		</AuthLayout>
	);
};

export default ForgotPassword;
