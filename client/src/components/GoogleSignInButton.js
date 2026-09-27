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
  // REACT_APP_GOOGLE_CLIENT_ID takes precedence; the public project client ID
  // below is a fallback so a deployment without the build-time env var still
  // gets a working button (a client ID is public, not a secret).
  const clientId =
    process.env.REACT_APP_GOOGLE_CLIENT_ID ||
    '719800879829-ali1g7m187jrfj78cqtg7t362ssn16l5.apps.googleusercontent.com';
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

    // The button only knows it is inside a dark document, so read the class the
    // theme provider toggles on <html>. A filled_black button keeps a readable
    // contrast on the dark auth panel, where the default outline does not.
    const isDark = () => document.documentElement.classList.contains('dark');

    const renderButton = () => {
      if (!window.google?.accounts?.id || !buttonRef.current) return;
      // Clamp to the container so the 360px default iframe cannot force a
      // horizontal scrollbar on a narrow phone.
      const available = buttonRef.current.clientWidth;
      const width = Math.max(180, Math.min(360, available || 360));
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
        type: 'standard',
        theme: isDark() ? 'filled_black' : 'outline',
        size: 'large',
        width,
        text: 'continue_with'
      });
      setReady(true);
    };

    // Re-render on resize so the clamped width tracks the viewport, and on a
    // theme switch so the button palette follows the rest of the auth screen.
    let resizeTimer;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(renderButton, 150);
    };
    const themeObserver = new MutationObserver(renderButton);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const existing = document.querySelector('script[data-google-identity]');
    if (existing) {
      existing.addEventListener('load', renderButton);
      renderButton();
      window.addEventListener('resize', onResize);
      return () => {
        existing.removeEventListener('load', renderButton);
        window.removeEventListener('resize', onResize);
        window.clearTimeout(resizeTimer);
        themeObserver.disconnect();
      };
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = 'true';
    script.addEventListener('load', renderButton);
    document.head.appendChild(script);
    window.addEventListener('resize', onResize);
    return () => {
      script.removeEventListener('load', renderButton);
      window.removeEventListener('resize', onResize);
      window.clearTimeout(resizeTimer);
      themeObserver.disconnect();
    };
  }, [clientId]);

  if (!clientId) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onError?.(new Error('Google Sign-In is not configured.'))}
        className="flex w-full items-center justify-center gap-3 rounded-xl border border-[#dfe7f1] bg-white px-4 py-3 text-sm font-semibold text-[#334155] shadow-sm transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-70 dark:border-slate-600 dark:bg-[#1a2436] dark:text-slate-200 dark:hover:bg-[#1e293b]"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 text-xs font-black text-[#d51d29]">G</span>
        Continue with Google
      </button>
    );
  }

  // `justify-center` matters: the button is rendered at a clamped pixel width
  // rather than `w-full`, so it centres instead of stretching.
  return <div className={`flex justify-center overflow-hidden ${isDisabled ? 'pointer-events-none opacity-60' : ''}`} aria-busy={!ready} ref={buttonRef} />;
};

export default GoogleSignInButton;
