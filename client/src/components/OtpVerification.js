import React, { useEffect, useRef, useState } from 'react';
import SubmitButton from './Layout/Common/SubmitButton';

const OTP_LENGTH = 6;

const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');

const cellClass =
  'h-12 w-full min-w-0 rounded-xl border border-[#dfe7f1] bg-[#f8fafc] text-center text-lg font-bold text-[#0f172a] outline-none transition focus:border-[#d51d29] focus:bg-white focus:ring-4 focus:ring-red-100 dark:border-slate-600 dark:bg-[#1a2436] dark:text-slate-100 dark:focus:bg-[#1e293b]';

const formatCountdown = (totalSeconds) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

// The email-code step of Google sign-in. The verified address arrives already
// masked from the server, so this screen never learns the real address, and it
// never holds a token: the session only exists after `onVerify` succeeds.
//
// The six boxes are one logical input split for readability. Typing advances,
// Backspace steps back, and a paste of six digits fills every box at once.
const OtpVerification = ({
  challengeId,
  email,
  expiresIn = 300,
  resendAvailableIn = 60,
  onVerify,
  onResend,
  onBack
}) => {
  const [digits, setDigits] = useState(() => Array(OTP_LENGTH).fill(''));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(resendAvailableIn);
  const inputsRef = useRef([]);

  const code = digits.join('');
  const complete = /^\d{6}$/.test(code);

  // The countdown restarts whenever a fresh challenge (or a fresh send with a
  // new cooldown) arrives from the server.
  useEffect(() => {
    setSecondsLeft(resendAvailableIn);
  }, [challengeId, resendAvailableIn]);

  // Clear whatever was typed when the challenge changes, so a previous code
  // can never be submitted against a new challenge id.
  useEffect(() => {
    setDigits(Array(OTP_LENGTH).fill(''));
    setError('');
  }, [challengeId]);

  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const timer = setTimeout(() => setSecondsLeft((current) => Math.max(0, current - 1)), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const focusAt = (index) => {
    inputsRef.current[index]?.focus();
  };

  const storeDigit = (index, raw) => {
    const char = digitsOnly(raw).slice(-1);
    setDigits((previous) => {
      const next = [...previous];
      next[index] = char;
      return next;
    });
    if (char && index < OTP_LENGTH - 1) focusAt(index + 1);
  };

  const handleKeyDown = (index, event) => {
    if (event.key !== 'Backspace') return;
    if (digits[index] === '' && index > 0) {
      event.preventDefault();
      focusAt(index - 1);
    }
  };

  const handlePaste = (event) => {
    event.preventDefault();
    const pasted = digitsOnly(event.clipboardData?.getData?.('text') ?? event.clipboardData ?? '');
    if (!pasted) return;
    const next = Array(OTP_LENGTH).fill('');
    for (let index = 0; index < OTP_LENGTH && index < pasted.length; index += 1) {
      next[index] = pasted[index];
    }
    setDigits(next);
    const lastFilled = Math.min(pasted.length, OTP_LENGTH) - 1;
    focusAt(lastFilled);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (verifying || !complete) return;
    setError('');
    setNotice('');
    setVerifying(true);
    try {
      await onVerify(code);
    } catch (requestError) {
      setError(
        requestError?.response?.data?.message ||
          requestError?.message ||
          'Unable to verify the code. Please try again.'
      );
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    if (resending || secondsLeft > 0) return;
    setError('');
    setNotice('');
    setResending(true);
    try {
      const data = await onResend();
      setDigits(Array(OTP_LENGTH).fill(''));
      setNotice(data?.message || 'A new verification code has been sent.');
      focusAt(0);
    } catch (requestError) {
      setError(
        requestError?.response?.data?.message ||
          requestError?.message ||
          'Unable to resend the code. Please try again.'
      );
    } finally {
      setResending(false);
    }
  };

  return (
    <div>
      {error && (
        <div
          role="alert"
          className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
        >
          {error}
        </div>
      )}

      <p className="text-sm text-[#475569] dark:text-slate-400">
        Enter the 6-digit code we sent to <span className="font-semibold text-[#0f172a] dark:text-slate-100">{email}</span>. It
        expires in {Math.max(1, Math.round(expiresIn / 60))} minutes.
      </p>

      <form onSubmit={handleSubmit} className="mt-5 space-y-5">
        <div className="flex gap-2">
          {digits.map((digit, index) => (
            <input
              key={index}
              ref={(element) => {
                inputsRef.current[index] = element;
              }}
              value={digit}
              onChange={(event) => storeDigit(index, event.target.value)}
              onKeyDown={(event) => handleKeyDown(index, event)}
              onPaste={handlePaste}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              maxLength={OTP_LENGTH}
              aria-label={`Verification digit ${index + 1}`}
              className={cellClass}
            />
          ))}
        </div>

        <SubmitButton
          type="submit"
          loading={verifying}
          loadingLabel="Verifying…"
          disabled={!complete}
          className="w-full rounded-xl bg-[#d51d29] px-4 py-3.5 font-semibold text-white shadow-lg shadow-red-200 transition hover:bg-[#b91c26]"
        >
          Verify
        </SubmitButton>
      </form>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
        {secondsLeft > 0 ? (
          <span className="text-[#64748b] dark:text-slate-500" aria-live="polite">
            Resend code in {formatCountdown(secondsLeft)}
          </span>
        ) : (
          <button
            type="button"
            onClick={handleResend}
            disabled={resending}
            className="font-semibold text-[#d51d29] hover:text-[#b91c26] disabled:cursor-not-allowed disabled:opacity-70 dark:text-[#ff8a90]"
          >
            {resending ? 'Sending…' : 'Resend code'}
          </button>
        )}

        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="font-semibold text-[#64748b] hover:text-[#334155] dark:text-slate-400 dark:hover:text-slate-200"
          >
            Use a different account
          </button>
        )}
      </div>

      <div role="status" aria-live="polite" className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
        {notice}
      </div>
    </div>
  );
};

export default OtpVerification;
