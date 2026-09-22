import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import API from '../services/api';

const ForgotPassword = () => {
	const [email, setEmail] = useState('');
	const [error, setError] = useState('');
	const [success, setSuccess] = useState('');
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (event) => {
		event.preventDefault();
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
		<main className="min-h-screen bg-[#f4f6f9] px-4 py-10 flex items-center justify-center">
			<div className="w-full max-w-5xl overflow-hidden rounded-[32px] border border-[#e5e7eb] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
				<div className="grid md:grid-cols-[1.05fr_1fr]">
					<section className="hidden md:flex flex-col justify-between bg-[#0f172a] p-10 text-white">
						<div>
							<div className="flex items-center gap-3">
								<div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#d51d29] text-lg font-black text-white shadow-lg shadow-red-200">
									RZ
								</div>
								<div className="text-2xl font-black tracking-[-0.05em] text-white">RicozContract</div>
							</div>
							<div className="mt-10 space-y-4">
								<p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Account recovery</p>
								<h1 className="text-4xl font-black leading-tight tracking-[-0.06em]">Reset your password securely.</h1>
							</div>
						</div>

						<div className="mt-10 rounded-[24px] border border-white/10 bg-white/5 p-5 shadow-inner shadow-slate-900/10">
							<div className="space-y-3 text-sm text-slate-200">
								<div className="rounded-xl bg-white/5 px-3 py-2">We email you a secure, one-time reset link.</div>
								<div className="rounded-xl bg-white/5 px-3 py-2">The link expires quickly and works only once.</div>
							</div>
						</div>
					</section>

					<section className="p-8 md:p-10 lg:p-12">
						<div className="mb-8">
							<p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#d51d29]">RicozContract</p>
							<h1 className="mt-3 text-3xl font-black tracking-[-0.05em] text-[#0f172a] md:text-4xl">Forgot password?</h1>
							<p className="mt-2 text-sm text-[#475569]">Enter your registered email and we will send you a reset link.</p>
						</div>

						{error && (
							<div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
								{error}
							</div>
						)}

						{success && (
							<div role="status" className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
								{success}
							</div>
						)}

						<form onSubmit={handleSubmit} className="space-y-5">
							<label className="block text-sm font-medium text-[#334155]">
								Email address
								<input
									name="email"
									type="email"
									autoComplete="email"
									required
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									className="mt-2 w-full rounded-xl border border-[#dfe7f1] bg-[#f8fafc] px-3 py-3 text-[#0f172a] outline-none transition focus:border-[#d51d29] focus:bg-white focus:ring-4 focus:ring-red-100"
								/>
							</label>

							<button
								type="submit"
								disabled={loading}
								className="w-full rounded-xl bg-[#d51d29] px-4 py-3.5 font-semibold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26] disabled:cursor-not-allowed disabled:opacity-70"
							>
								{loading ? 'Sending...' : 'Send reset link'}
							</button>
						</form>

						<p className="mt-6 text-center text-sm text-[#475569]">
							Remembered it?{' '}
							<Link to="/login" className="font-semibold text-[#d51d29] hover:text-[#b91c26]">
								Back to Sign in
							</Link>
						</p>
					</section>
				</div>
			</div>
		</main>
	);
};

export default ForgotPassword;
