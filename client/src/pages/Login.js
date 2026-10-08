import React, { useContext, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import GoogleSignInButton from '../components/GoogleSignInButton';
import OtpVerification from '../components/OtpVerification';
import PasswordInput from '../components/PasswordInput';
import SubmitButton from '../components/Layout/Common/SubmitButton';
import AuthLayout, { AuthAside, inputClass, labelClass } from '../components/Layout/AuthLayout';

const Login = () => {
	const { login, beginGoogleOtp, verifyGoogleOtp, resendGoogleOtp } = useContext(AuthContext);
	const navigate = useNavigate();
	const [form, setForm] = useState({ email: '', password: '' });
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);
	// Google sign-in is two steps: the credential first, then the emailed code.
	// While `googleStep` holds the challenge, the code screen replaces the form.
	const [googleStep, setGoogleStep] = useState(null);

	const handleChange = (event) => {
		setForm({ ...form, [event.target.name]: event.target.value });
	};

	// The `loading` guard is the second half of duplicate-submit protection:
	// the button is disabled while in flight, and an Enter keypress that slips
	// through before the re-render returns early instead of firing twice.
	const handleSubmit = async (event) => {
		event.preventDefault();
		if (loading) return;
		setError('');
		setLoading(true);

		try {
			await login(form.email, form.password);
			navigate('/dashboard', { replace: true });
		} catch (requestError) {
			setError(requestError.response?.data?.message || 'Unable to sign in. Please try again.');
		} finally {
			setLoading(false);
		}
	};

	const handleGoogleCredential = async (credential) => {
		if (loading) return;
		setError('');
		setLoading(true);
		try {
			// No session is created here: the server answers with a masked email
			// and a challenge, and the code screen takes over.
			const step = await beginGoogleOtp(credential);
			setGoogleStep(step);
		} catch (requestError) {
			const response = requestError.response?.data;
			setError(response?.detail || response?.message || 'Unable to sign in with Google.');
		} finally {
			setLoading(false);
		}
	};

	const handleOtpVerify = async (otp) => {
		await verifyGoogleOtp({ challengeId: googleStep.challengeId, otp });
		navigate('/dashboard', { replace: true });
	};

	const handleOtpResend = () => resendGoogleOtp(googleStep.challengeId);

	const handleOtpBack = () => {
		setGoogleStep(null);
		setError('');
	};

	return (
		<AuthLayout
			eyebrow="RicozContract"
			title="Welcome back"
			subtitle="Sign in to manage your contracts."
			aside={
				<AuthAside
					headline="Every contract, obligation and renewal in one place."
					stats={[
						['Approvals with a recorded decision', 'Always'],
						['Renewal windows tracked', '30 · 60 · 90 days'],
						['Role-based access', 'Admin · Manager · Employee']
					]}
				/>
			}
			footer={
				<>
					Need an account?{' '}
					<Link to="/register" className="font-semibold text-[#d51d29] hover:text-[#b91c26] dark:text-[#ff8a90]">
						Create one
					</Link>
				</>
			}
		>
			{googleStep ? (
				<OtpVerification
					challengeId={googleStep.challengeId}
					email={googleStep.email}
					expiresIn={googleStep.expiresIn}
					resendAvailableIn={googleStep.resendAvailableIn}
					onVerify={handleOtpVerify}
					onResend={handleOtpResend}
					onBack={handleOtpBack}
				/>
			) : (
				<>
					{error && (
						<div
							role="alert"
							className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
						>
							{error}
						</div>
					)}

					<form onSubmit={handleSubmit} className="space-y-5">
						<label className={labelClass} htmlFor="login-email">
							Email address
							<input
								id="login-email"
								name="email"
								type="email"
								autoComplete="email"
								required
								value={form.email}
								onChange={handleChange}
								className={inputClass}
							/>
						</label>

						<div className="flex items-baseline justify-between gap-3">
							<label htmlFor="login-password" className={labelClass}>
								Password
							</label>
							<Link to="/forgot-password" className="shrink-0 text-sm font-semibold text-[#d51d29] hover:text-[#b91c26] dark:text-[#ff8a90]">
								Forgot password?
							</Link>
						</div>
						<PasswordInput
							id="login-password"
							name="password"
							autoComplete="current-password"
							required
							value={form.password}
							onChange={handleChange}
							className={inputClass}
						/>

						<SubmitButton
							loading={loading}
							loadingLabel="Signing in…"
							className="w-full rounded-xl bg-[#d51d29] px-4 py-3.5 font-semibold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26]"
						>
							Sign in
						</SubmitButton>
					</form>

					<div className="my-6 flex items-center gap-3 text-xs font-medium uppercase tracking-[0.14em] text-slate-400">
						<span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
						or
						<span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
					</div>

					<GoogleSignInButton
						onCredential={handleGoogleCredential}
						onError={(googleError) => setError(googleError.message || 'Google Sign-In could not be opened.')}
						disabled={loading}
					/>
				</>
			)}
		</AuthLayout>
	);
};

export default Login;
