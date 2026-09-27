import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import API from '../services/api';
import PasswordInput from '../components/PasswordInput';
import SubmitButton from '../components/Layout/Common/SubmitButton';
import AuthLayout, { AuthAside, inputClass, labelClass } from '../components/Layout/AuthLayout';

const ResetPassword = () => {
	const [searchParams] = useSearchParams();
	const token = searchParams.get('token') || '';
	const [password, setPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [error, setError] = useState('');
	const [success, setSuccess] = useState('');
	const [loading, setLoading] = useState(false);

	const hasToken = Boolean(token);

	const handleSubmit = async (event) => {
		event.preventDefault();
		if (loading) return;
		setError('');
		setSuccess('');

		if (password !== confirmPassword) {
			setError('Passwords do not match.');
			return;
		}
		if (password.length < 6) {
			setError('Password must be at least 6 characters.');
			return;
		}

		setLoading(true);
		try {
			const { data } = await API.post('/auth/reset-password', { token, password });
			setSuccess(data.message || 'Your password has been reset. You can now sign in.');
			setPassword('');
			setConfirmPassword('');
		} catch (requestError) {
			const response = requestError.response?.data;
			if (requestError.response?.status === 429) {
				setError(response?.message || 'Too many attempts. Please try again later.');
			} else {
				setError(response?.message || 'Unable to reset your password. Please try again.');
			}
		} finally {
			setLoading(false);
		}
	};

	return (
		<AuthLayout
			eyebrow="RicozContract"
			title="Reset password"
			subtitle="Create a new password for your account."
			aside={
				<AuthAside
					headline="Choose a new password."
					stats={[
						['Minimum length', '6 characters'],
						['Link usage', 'Once only'],
						['Other sessions', 'Revoked on success']
					]}
				/>
			}
			footer={
				<Link to="/login" className="font-semibold text-[#d51d29] hover:text-[#b91c26] dark:text-[#ff8a90]">
					Back to sign in
				</Link>
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

			{success && (
				<div
					role="status"
					className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300"
				>
					{success}
				</div>
			)}

			{hasToken ? (
				<form onSubmit={handleSubmit} className="space-y-5">
					<label className={labelClass} htmlFor="reset-password">
						New password
						<PasswordInput
							id="reset-password"
							name="password"
							autoComplete="new-password"
							required
							minLength="6"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							className={inputClass}
						/>
					</label>

					<label className={labelClass} htmlFor="reset-confirm">
						Confirm new password
						<PasswordInput
							id="reset-confirm"
							name="confirmPassword"
							autoComplete="new-password"
							required
							minLength="6"
							value={confirmPassword}
							onChange={(event) => setConfirmPassword(event.target.value)}
							className={inputClass}
						/>
					</label>

					<SubmitButton
						loading={loading}
						loadingLabel="Resetting…"
						className="w-full rounded-xl bg-[#d51d29] px-4 py-3.5 font-semibold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26]"
					>
						Reset password
					</SubmitButton>
				</form>
			) : (
				!success && (
					<div
						role="alert"
						className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
					>
						This reset link is invalid or has expired. Please request a new one.
						<div className="mt-3">
							<Link to="/forgot-password" className="font-semibold underline">
								Request a new link
							</Link>
						</div>
					</div>
				)
			)}
		</AuthLayout>
	);
};

export default ResetPassword;
