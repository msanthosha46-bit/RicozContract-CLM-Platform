import React, { useEffect, useRef, useState } from 'react';

// `state` identifies a rendered GIS button generation. GIS returns it with a
// credential response, letting the coordinator reject callbacks from retired
// button generations. Attempt IDs are separate because one generation can be
// clicked at most once.
const mountedOwners = new Map();
const buttonGenerations = new Map();
const stateSubscribers = new Map();
let activeAttempt = null;
let initializedIdApi = null;
let initializedClientId = null;
let nextOwnerId = 0;
let nextGenerationId = 0;
let nextAttemptId = 0;

const notifyCoordinator = () => {
  const pending = activeAttempt !== null;
  stateSubscribers.forEach(({ ownerId, update, hostRef }) => {
    update(pending);
    // Apply synchronously from GIS's click listener so another rendered host
    // cannot receive a later user click before React commits its state update.
    if (hostRef.current) {
      hostRef.current.style.pointerEvents = pending ? 'none' : '';
    }
  });
};

const beginAttempt = (owner, generationState) => {
  if (
    activeAttempt ||
    !owner.mounted ||
    mountedOwners.get(owner.ownerId) !== owner ||
    owner.currentGeneration !== generationState ||
    buttonGenerations.get(generationState) !== owner
  ) {
    return false;
  }

  const attempt = {
    id: ++nextAttemptId,
    ownerId: owner.ownerId,
    generationState,
    consumed: false
  };
  owner.latestAttemptId = attempt.id;
  activeAttempt = attempt;
  notifyCoordinator();
  return true;
};

const createGeneration = (owner) => {
  const generationState = `${owner.ownerId}:generation-${++nextGenerationId}`;
  owner.currentGeneration = generationState;
  buttonGenerations.set(generationState, owner);
  return generationState;
};

const consumeCredential = (response) => {
  const state = response?.state;
  const attempt = activeAttempt;
  if (!state || !attempt || attempt.consumed || attempt.generationState !== state) return;

  // Consume before any React rendering or application callback. That makes a
  // duplicate response for this state inert, including one arriving during a
  // button re-render. The next attempt receives a different GIS state value.
  attempt.consumed = true;
  activeAttempt = null;
  const owner = buttonGenerations.get(state);
  const ownerIsMounted = Boolean(
    owner && owner.mounted && mountedOwners.get(attempt.ownerId) === owner && owner.currentGeneration === state
  );
  buttonGenerations.delete(state);

  if (ownerIsMounted) {
    owner.currentGeneration = null;
    owner.renderButton?.();
  }
  notifyCoordinator();

  // A callback received after unmount only releases the shared reservation.
  if (!ownerIsMounted) return;

  let handlerResult;
  try {
    handlerResult = owner.onCredentialRef.current?.(response.credential);
  } catch (error) {
    if (mountedOwners.get(owner.ownerId) === owner && owner.latestAttemptId === attempt.id) {
      owner.onErrorRef.current?.(error);
    }
    return;
  }

  return Promise.resolve(handlerResult).catch((error) => {
    // An older handler rejection must not surface during a later attempt.
    if (mountedOwners.get(owner.ownerId) === owner && owner.latestAttemptId === attempt.id) {
      owner.onErrorRef.current?.(error);
    }
  });
};

const GoogleSignInButton = ({ onCredential, onError, disabled = false }) => {
  const hostRef = useRef(null);
  const buttonRef = useRef(null);
  const ownerIdRef = useRef(null);
  if (!ownerIdRef.current) ownerIdRef.current = `google-sign-in-${++nextOwnerId}`;
  const ownerId = ownerIdRef.current;
  const [ready, setReady] = useState(false);
  const [signInPending, setSignInPending] = useState(activeAttempt !== null);

  // REACT_APP_GOOGLE_CLIENT_ID takes precedence; the public project client ID
  // below is a fallback so a deployment without the build-time env var still
  // gets a working button (a client ID is public, not a secret).
  const clientId =
    process.env.REACT_APP_GOOGLE_CLIENT_ID ||
    '719800879829-ali1g7m187jrfj78cqtg7t362ssn16l5.apps.googleusercontent.com';
  const isDisabled = disabled || !clientId || signInPending;

  // Keep the latest callbacks without re-running the GIS effect.
  const onCredentialRef = useRef(onCredential);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onCredentialRef.current = onCredential;
    onErrorRef.current = onError;
  }, [onCredential, onError]);

  useEffect(() => {
    if (!clientId || !buttonRef.current) return undefined;

    const owner = {
      ownerId,
      mounted: true,
      currentGeneration: null,
      latestAttemptId: 0,
      onCredentialRef,
      onErrorRef,
      renderButton: null
    };
    mountedOwners.set(ownerId, owner);
    const updatePendingState = (pending) => setSignInPending(pending);
    stateSubscribers.set(ownerId, { ownerId, update: updatePendingState, hostRef });
    updatePendingState(activeAttempt !== null);
    if (hostRef.current) hostRef.current.style.pointerEvents = activeAttempt ? 'none' : '';

    const isDark = () => document.documentElement.classList.contains('dark');
    const renderButton = () => {
      if (!window.google?.accounts?.id || !buttonRef.current || !owner.mounted) return;
      // Keep an in-flight button instance intact so its credential can still
      // finish the attempt it started. Theme and resize renders are deferred
      // until that attempt reaches a terminal credential callback.
      if (activeAttempt?.ownerId === owner.ownerId) return;

      const idApi = window.google.accounts.id;
      if (initializedIdApi !== idApi || initializedClientId !== clientId) {
        idApi.initialize({
          client_id: clientId,
          callback: consumeCredential
        });
        initializedIdApi = idApi;
        initializedClientId = clientId;
      }

      const available = buttonRef.current.clientWidth;
      const width = Math.max(180, Math.min(360, available || 360));
      const previousGeneration = owner.currentGeneration;
      const generationState = createGeneration(owner);
      // Retire the previous listener/state before replacing its DOM. A click
      // captured by that button can no longer reserve a new attempt.
      if (previousGeneration) buttonGenerations.delete(previousGeneration);
      buttonRef.current.replaceChildren();
      idApi.renderButton(buttonRef.current, {
        type: 'standard',
        theme: isDark() ? 'filled_black' : 'outline',
        size: 'large',
        width,
        text: 'continue_with',
        state: generationState,
        click_listener: () => beginAttempt(owner, generationState)
      });
      setReady(true);
    };
    owner.renderButton = renderButton;
    // Each actual render receives a fresh state. Strict Mode replay starts with
    // a new owner generation after cleanup removes the previous one.
    renderButton();

    let resizeTimer;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(renderButton, 150);
    };
    const themeObserver = new MutationObserver(renderButton);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    let script = document.querySelector('script[data-google-identity]');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentity = 'true';
      document.head.appendChild(script);
    }
    script.addEventListener('load', renderButton);
    window.addEventListener('resize', onResize);

    return () => {
      owner.mounted = false;
      mountedOwners.delete(ownerId);
      stateSubscribers.delete(ownerId);
      if (owner.currentGeneration) buttonGenerations.delete(owner.currentGeneration);
      owner.currentGeneration = null;
      buttonRef.current?.replaceChildren();
      script.removeEventListener('load', renderButton);
      window.removeEventListener('resize', onResize);
      window.clearTimeout(resizeTimer);
      themeObserver.disconnect();
      // Do not clear a pending attempt here: GIS provides no documented button
      // cancellation signal. Its eventual credential is consumed and discarded.
    };
  }, [clientId, ownerId]);

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

  return (
    <div
      ref={hostRef}
      className={`flex flex-col items-center overflow-hidden ${isDisabled ? 'pointer-events-none opacity-60' : ''}`}
      aria-busy={!ready || signInPending}
    >
      <div className="flex justify-center overflow-hidden w-full" ref={buttonRef} />
      {signInPending && (
        <div role="status" aria-live="polite" className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400 pointer-events-auto">
          Google Sign-In is still waiting for a response. If it does not finish, reload this page to try again.
          <button
            type="button"
            className="ml-1 underline"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      )}
    </div>
  );
};

export default GoogleSignInButton;
