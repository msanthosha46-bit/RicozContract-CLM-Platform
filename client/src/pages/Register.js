import React, { useContext, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import GoogleSignInButton from '../components/GoogleSignInButton';
import OtpVerification from '../components/OtpVerification';
import PasswordInput from '../components/PasswordInput';
import SubmitButton from '../components/Layout/Common/SubmitButton';
import AuthLayout, { AuthAside, inputClass, labelClass } from '../components/Layout/AuthLayout';

const Register = () => {
	const { register, beginGoogleOtp, verifyGoogleOtp, resendGoogleOtp } = useContext(AuthContext);
	const navigate = useNavigate();
	const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '', department: '' });
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);
	// Google sign-in is two steps here too: credential, then the emailed code.
	const [googleStep, setGoogleStep] = useState(null);

	const handleChange = (event) => {
		setForm({ ...form, [event.target.name]: event.target.value });
	};

	const handleSubmit = async (event) => {
		event.preventDefault();
		if (loading) return;
		setError('');

		if (form.password !== form.confirmPassword) {
			setError('Passwords do not match.');
			return;
		}

		setLoading(true);
		try {
			const { confirmPassword, ...payload } = form;
			await register(payload);
			navigate('/dashboard', { replace: true });
		} catch (requestError) {
			setError(requestError.response?.data?.message || 'Unable to create your account.');
		} finally {
			setLoading(false);
		}
	};

	const handleGoogleCredential = async (credential) => {
		if (loading) return;
		setError('');
		setLoading(true);
		try {
			// No account is created here: the server answers with a masked email
			// and a challenge, and the code screen takes over. The account (or
			// the link to the existing one) only happens after the code checks.
			const step = await beginGoogleOtp(credential);
			setGoogleStep(step);
		} catch (requestError) {
			const response = requestError.response?.data;
			setError(response?.detail || response?.message || 'Unable to continue with Google.');
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
			title="Create your workspace"
			subtitle="Start managing your contract workspace."
			aside={
				<AuthAside
					headline="One workspace for every agreement you sign."
					stats={[
						['New accounts start as', 'Employee'],
						['Roles an admin can assign', 'Admin · Manager'],
						['Trial or card required', 'None']
					]}
				/>
			}
			footer={
				<>
					Already registered?{' '}
					<Link to="/login" className="font-semibold text-[#d51d29] hover:text-[#b91c26] dark:text-[#ff8a90]">
						Sign in
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

					<form onSubmit={handleSubmit} className="space-y-4">
						<label className={labelClass} htmlFor="register-name">
							Full name
							<input id="register-name" name="name" required value={form.name} onChange={handleChange} className={inputClass} />
						</label>
						<label className={labelClass} htmlFor="register-email">
							Email address
							<input
								id="register-email"
								name="email"
								type="email"
								autoComplete="email"
								required
								value={form.email}
								onChange={handleChange}
								className={inputClass}
							/>
						</label>
						<label className={labelClass} htmlFor="register-department">
							Department
							<input
								id="register-department"
								name="department"
								autoComplete="organization-title"
								value={form.department}
								onChange={handleChange}
								className={inputClass}
							/>
						</label>
						<label className={labelClass} htmlFor="register-password">
							Password
							<PasswordInput
								id="register-password"
								name="password"
								autoComplete="new-password"
								required
								minLength="6"
								value={form.password}
								onChange={handleChange}
								className={inputClass}
							/>
						</label>
						<label className={labelClass} htmlFor="register-confirm">
							Confirm password
							<PasswordInput
								id="register-confirm"
								name="confirmPassword"
								autoComplete="new-password"
								required
								minLength="6"
								value={form.confirmPassword}
								onChange={handleChange}
								className={inputClass}
							/>
						</label>

						<SubmitButton
							loading={loading}
							loadingLabel="Creating account…"
							className="mt-2 w-full rounded-xl bg-[#d51d29] px-4 py-3.5 font-semibold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26]"
						>
							Create account
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

export default Register;
