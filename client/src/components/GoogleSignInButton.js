import React, { useEffect, useRef, useState } from 'react';

const GOOGLE_ERROR_MESSAGES = {
  popup_closed: 'Google Sign-In was cancelled.',
  popup_failed_to_open: 'Google Sign-In could not be opened.',
  opt_out_or_no_session: 'Google Sign-In was cancelled.',
  unknown: 'Google Sign-In could not be completed.'
};

const GoogleSignInButton = ({ onCredential, onError, disabled = false }) => {
  const buttonRef = useRef(null);
  const [ready, setReady] = useState(false);
  const clientId = process.env.REACT_APP_GOOGLE_CLIENT_ID;
  const isDisabled = disabled || !clientId;

  // Keep the latest callbacks without re-running the effect (which would
  // re-render the Google button on every parent state change).
  const onCredentialRef = useRef(onCredential);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onCredentialRef.current = onCredential;
    onErrorRef.current = onError;
  }, [onCredential, onError]);

  useEffect(() => {
    if (!clientId || !buttonRef.current) return undefined;

    const renderButton = () => {
      if (!window.google?.accounts?.id || !buttonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (response) => {
          try {
            await onCredentialRef.current?.(response.credential);
          } catch (error) {
            onErrorRef.current?.(error);
          }
        },
        error_callback: (error) => {
          const type = error?.type;
          const message =
            GOOGLE_ERROR_MESSAGES[type] ||
            (type ? 'Google Sign-In could not be completed.' : GOOGLE_ERROR_MESSAGES.unknown);
          onErrorRef.current?.(new Error(message));
        }
      });
      buttonRef.current.replaceChildren();
      window.google.accounts.id.renderButton(buttonRef.current, {
        type: 'standard', theme: 'outline', size: 'large', width: 360, text: 'continue_with'
      });
      setReady(true);
    };

    const existing = document.querySelector('script[data-google-identity]');
    if (existing) {
      existing.addEventListener('load', renderButton);
      renderButton();
      return () => existing.removeEventListener('load', renderButton);
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = 'true';
    script.addEventListener('load', renderButton);
    document.head.appendChild(script);
    return () => script.removeEventListener('load', renderButton);
  }, [clientId]);

  if (!clientId) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onError?.(new Error('Google Sign-In is not configured.'))}
        className="flex w-full items-center justify-center gap-3 rounded-xl border border-[#dfe7f1] bg-white px-4 py-3 text-sm font-semibold text-[#334155] shadow-sm transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-70"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 text-xs font-black text-[#d51d29]">G</span>
        Continue with Google
      </button>
    );
  }

  return <div className={isDisabled ? 'pointer-events-none opacity-60' : ''} aria-busy={!ready} ref={buttonRef} />;
};

export default GoogleSignInButton;
