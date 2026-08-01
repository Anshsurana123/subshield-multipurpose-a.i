"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PravaSession, CheckoutOutcome } from "@/lib/types";
import { motion, AnimatePresence } from "framer-motion";
import { X, Lock, ShieldCheck, CreditCard, CheckCircle2 } from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  session: PravaSession | null;
  vendor: string;
  originalPrice: number;
  negotiatedPrice: number;
  onCheckoutComplete: (outcome: CheckoutOutcome) => void;
}

interface CredentialReadyState {
  txnRefId: string;
  tokenLast4: string;
  status: 'executing' | 'completed';
}

export default function PravaCheckoutModal({
  isOpen,
  onClose,
  session,
  vendor,
  originalPrice,
  negotiatedPrice,
  onCheckoutComplete
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sdkRef = useRef<{ destroy: () => void } | null>(null);
  const hasStarted = useRef(false);
  const isCompleting = useRef(false);

  const [isLoading, setIsLoading] = useState(true);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [credentialReady, setCredentialReady] = useState<CredentialReadyState | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);

  // Executes the charge with the granted one-time credential and reports the
  // outcome to Prava. Lives at component scope so the UI can offer a retry.
  const completeCheckout = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch('/api/prava/complete-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json().catch(() => ({}));

      if (data?.status === 'completed') {
        setCompleteError(null);
        setCredentialReady((prev) => (prev ? { ...prev, status: 'completed' } : prev));
        return;
      }
      if (data?.status === 'failed') {
        setCredentialReady(null);
        setVerificationError(
          data?.error?.message || 'Prava could not complete the purchase. Please create a new checkout session and try again.'
        );
        return;
      }
      setCompleteError(
        'The purchase could not be finalized. Please try again, or create a new checkout session.'
      );
    } catch (e) {
      console.error('Complete checkout error:', e);
      setCompleteError(
        'The purchase could not be finalized. Please try again, or create a new checkout session.'
      );
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !session || hasStarted.current || !containerRef.current) return;
    hasStarted.current = true;
    isCompleting.current = false;
    setIsLoading(true);
    setVerificationError(null);
    setCredentialReady(null);
    setCompleteError(null);

    let pollTimer: NodeJS.Timeout | undefined;
    let observer: MutationObserver | undefined;

    const applyPermissions = () => {
      const iframes = containerRef.current?.querySelectorAll("iframe");
      iframes?.forEach((f) => {
        f.setAttribute("allow", "publickey-credentials-get *; payment *");
        f.style.width = "100%";
        f.style.minHeight = "580px";
      });
    };

    if (containerRef.current) {
      observer = new MutationObserver(() => {
        applyPermissions();
      });
      observer.observe(containerRef.current, { childList: true, subtree: true });
    }

    const startPollingPaymentResult = (sessionId: string) => {
      if (pollTimer) clearInterval(pollTimer);
      let attempts = 0;
      let consecutivePollFailures = 0;

      const poll = async () => {
        if (isCompleting.current) return;
        attempts++;

        try {
          const res = await fetch(`/api/prava/payment-result?sessionId=${encodeURIComponent(sessionId)}&_t=${Date.now()}`, {
            cache: 'no-store',
          });
          if (!res.ok) {
            const error = await res.json().catch(() => ({}));
            consecutivePollFailures++;
            console.error('[Prava] Payment-result poll failed:', res.status, error);
            if (consecutivePollFailures >= 3) {
              if (pollTimer) clearInterval(pollTimer);
              setVerificationError(error.error || 'We could not confirm the payment result. Please create a new checkout session and try again.');
              setIsLoading(false);
            }
            return;
          }
          consecutivePollFailures = 0;
          const data = await res.json();
          
          const status = String(data.status || data.state || '').toLowerCase();
          const items = data.line_items || data.lineItems || [];
          const item = items[0] || {};
          const tokenLast4 = item.tokenLast4 || (item.token ? item.token.slice(-4) : '••••');
          const txnRefId = item.txnRefId || item.txn_ref_id || item.id || '';
          console.info('[Prava] Payment-result status:', status);

          if (status === 'failed') {
            if (pollTimer) clearInterval(pollTimer);
            setVerificationError(data.error?.message || 'Prava could not complete the purchase. Please create a new checkout session and try again.');
            setIsLoading(false);
            return;
          }

          const isReady = status === 'awaiting_result' || status === 'completed';

          if (isReady && txnRefId) {
            // Guard against overlapping async polls double-triggering.
            if (isCompleting.current) return;
            if (pollTimer) clearInterval(pollTimer);
            isCompleting.current = true;
            setIsLoading(false);

            // IMMEDIATELY clear the iframe container before reporting status to Prava.
            // When reportTransactionStatus is called, Prava closes/revokes the session token.
            // If the iframe remains in the DOM, it detects the revoked session and shows
            // "Session Revoked" error to the user.
            if (containerRef.current) {
              containerRef.current.innerHTML = "";
            }

            if (status === 'awaiting_result') {
              // Credentials granted (one-time network token + dynamic CVV) but the
              // purchase is NOT complete yet. Execute the charge with those
              // credentials, then report the outcome to Prava to close the session.
              setCredentialReady({ txnRefId, tokenLast4, status: 'executing' });
              void completeCheckout(sessionId);
            } else {
              setCredentialReady({ txnRefId, tokenLast4, status: 'completed' });
            }
          }
        } catch (e) {
          console.error("Payment polling error:", e);
        }

        if (attempts > 60 && pollTimer) {
          clearInterval(pollTimer);
          setVerificationError('Verification is taking longer than expected. Please create a new checkout session and try again.');
          setIsLoading(false);
        }
      };

      void poll();
      pollTimer = setInterval(poll, 2000);
    };

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (
          data === 'prava_success' ||
          data?.type === 'prava_success' ||
          data?.status === 'completed' ||
          data?.status === 'awaiting_result'
        ) {
          startPollingPaymentResult(session.sessionId);
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    window.addEventListener('message', handleMessage);

    const initPravaSDK = async () => {
      try {
        const supportsPlatformPasskey =
          typeof window.PublicKeyCredential !== "undefined" &&
          typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function" &&
          await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();

        if (!supportsPlatformPasskey) {
          setVerificationError(
            "This browser cannot use a platform passkey. Set up Windows Hello, then retry in Chrome or Edge."
          );
          setIsLoading(false);
          return;
        }

        const { PravaSDK } = await import("@prava-sdk/core");
        const pubKey = process.env.NEXT_PUBLIC_PRAVA_PUBLISHABLE_KEY || "pk_test_subshield_demo";
        const pravaInstance = new PravaSDK({ publishableKey: pubKey });
        sdkRef.current = pravaInstance;

        if (containerRef.current && session.iframeUrl && session.sessionToken) {
          containerRef.current.innerHTML = "";
          
          await pravaInstance.collectPAN({
            sessionToken: session.sessionToken,
            iframeUrl: session.iframeUrl,
            container: containerRef.current,
            onReady: () => {
              applyPermissions();
              setIsLoading(false);
            },
            onSuccess: () => {
              startPollingPaymentResult(session.sessionId);
            },
            onError: (err: any) => {
              console.error("Prava SDK Error:", err);
              const message = String(err?.message || err?.code || err);
              if (/AUTH_NOT_SUPPORTED|FIDO|WEBAUTHN_NOT_SUPPORTED/i.test(message)) {
                setVerificationError(
                  "Passkey verification is unavailable in this browser. Set up Windows Hello, then retry in Chrome or Edge."
                );
              } else {
                setVerificationError("Secure verification could not be started. Please create a new checkout session and try again.");
              }
              setIsLoading(false);
            }
          });
        } else {
          mountDirectIframe();
        }
      } catch (err) {
        console.warn("Prava SDK fallback to direct iframe element:", err);
        mountDirectIframe();
      }

    };

    const mountDirectIframe = () => {
      if (!session?.iframeUrl || !containerRef.current) {
        setIsLoading(false);
        return;
      }
      containerRef.current.innerHTML = "";
      const iframe = document.createElement("iframe");
      iframe.src = session.iframeUrl;
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.minHeight = "580px";
      iframe.style.border = "none";
      iframe.style.borderRadius = "12px";
      iframe.setAttribute("allow", "publickey-credentials-get *; payment *");
      iframe.onload = () => {
        applyPermissions();
        setIsLoading(false);
      };
      containerRef.current.appendChild(iframe);
    };

    // Start immediately, not from the iframe callback. The SDK can leave its iframe
    // blank after passkey approval without resolving collectPAN or firing onSuccess.
    startPollingPaymentResult(session.sessionId);
    initPravaSDK();

    const spinnerTimeout = setTimeout(() => {
      applyPermissions();
      setIsLoading(false);
    }, 3500);

    return () => {
      hasStarted.current = false;
      sdkRef.current?.destroy();
      sdkRef.current = null;
      clearTimeout(spinnerTimeout);
      if (pollTimer) clearInterval(pollTimer);
      if (observer) observer.disconnect();
      window.removeEventListener('message', handleMessage);
    };
  }, [isOpen, session, completeCheckout]);

  const handleCredentialReady = () => {
    if (!session || !credentialReady || credentialReady.status !== 'completed') return;

    const outcome: CheckoutOutcome = {
      sessionId: session.sessionId,
      orderId: session.orderId || `ord_${Math.random().toString(36).substring(7)}`,
      status: 'completed',
      tokenLast4: credentialReady.tokenLast4,
      amountPaid: String(negotiatedPrice),
      merchantName: vendor,
      reportedToVisa: true,
      authorizationCode: '',
      completedAt: new Date().toISOString()
    };
    onCheckoutComplete(outcome);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[#17201c]/45 p-4 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20 }}
            className="my-auto flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#dfe5df] bg-white shadow-[0_24px_70px_rgba(15,30,20,0.22)]"
          >
            {/* Header / Rationale Card */}
            <div className="relative shrink-0 border-b border-[#e5e9e4] p-5 sm:p-6">
              <button 
                onClick={onClose}
                className="absolute right-4 top-4 rounded-md p-1.5 text-[#718077] transition-colors hover:bg-[#f2f4f1] hover:text-[#26332c]"
              >
                <X size={18} />
              </button>
              
              <div className="mb-3 flex items-center gap-2 text-[#176b4b]">
                <ShieldCheck size={18} />
                <span className="text-xs font-semibold">Protected payment approval</span>
              </div>
              
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-heading text-2xl font-bold tracking-[-0.04em] text-[#17201c]">{vendor}</h2>
                  <p className="mt-1 text-sm text-[#6d7971]">Approve the agreed rate and create a merchant-specific mandate.</p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="text-xs text-[#879188] line-through">${originalPrice.toFixed(2)}</span>
                  <span className="mt-1 block text-xl font-semibold tracking-[-0.03em] text-[#176b4b]">${negotiatedPrice.toFixed(2)}<span className="ml-1 text-xs font-medium">/mo</span></span>
                </div>
              </div>
              
              <div className="mt-5 flex items-center justify-between rounded-lg border border-[#d8e7dc] bg-[#f1f7f3] px-3 py-2 text-xs">
                <span className="text-[#526259]">Estimated annual savings</span>
                <span className="font-semibold text-[#176b4b]">${((originalPrice - negotiatedPrice) * 12).toFixed(2)}</span>
              </div>
            </div>

            {/* Prava Card Collection Container */}
            <div className="relative flex flex-grow flex-col space-y-3 overflow-y-auto p-5 sm:p-6">
              <div className="flex shrink-0 items-center justify-between text-xs text-[#69776e]">
                <div className="flex items-center gap-1.5">
                  <CreditCard size={14} className="text-[#176b4b]" />
                  <span className="font-semibold">Secure card verification</span>
                </div>
                <div className="flex items-center gap-1 rounded-md border border-[#dce6de] bg-[#f7faf7] px-2 py-1 text-[10px] font-semibold text-[#176b4b]">
                  <Lock size={10} />
                  <span>Cap ${negotiatedPrice.toFixed(2)}/mo</span>
                </div>
              </div>

              {/* Real Prava Sandbox Iframe Container */}
              <div className="relative flex min-h-[580px] w-full flex-col items-center justify-center overflow-y-auto rounded-xl border border-[#e1e6e0] bg-[#fafbf9]">
                {isLoading && !credentialReady && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center space-y-3 bg-white/95 p-4 text-center backdrop-blur">
                    <div className="size-8 animate-spin rounded-full border-2 border-[#176b4b]/20 border-t-[#176b4b]" />
                    <p className="text-xs font-medium text-[#526259]">Preparing secure verification…</p>
                  </div>
                )}

                {credentialReady && (
                  <div className="absolute inset-0 z-30 flex flex-col items-center justify-center space-y-4 bg-white/98 p-6 text-center backdrop-blur">
                    {credentialReady.status === 'executing' ? (
                      <>
                        {!completeError && (
                          <div className="flex size-12 items-center justify-center rounded-full border border-[#cde0d3] bg-[#f0f7f2]">
                            <div className="size-5 animate-spin rounded-full border-2 border-[#176b4b]/20 border-t-[#176b4b]" />
                          </div>
                        )}
                        <div className="max-w-sm">
                          <h4 className="text-base font-bold text-[#26332c]">{completeError ? 'Purchase not finalized' : 'Completing your purchase…'}</h4>
                          <p className="mt-1 text-xs leading-5 text-[#6a776f]">{completeError ? 'The charge could not be confirmed with Prava.' : 'The one-time payment credential was granted. SubShield is executing the charge with it and reporting the outcome to Prava to close the session.'}</p>
                        </div>
                        <div className="w-full max-w-xs rounded-lg border border-[#e0e6e0] bg-[#fafbf9] px-3 py-2 text-left text-xs">
                          <div className="flex items-center justify-between text-[#718077]"><span>Credential</span><span className="font-mono font-semibold text-[#314239]">•••• {credentialReady.tokenLast4}</span></div>
                          <div className="mt-1 flex items-center justify-between text-[#718077]"><span>State</span><span className="font-semibold text-[#176b4b]">{completeError ? 'Needs retry' : 'Executing payment…'}</span></div>
                        </div>
                        {completeError && (
                          <>
                            <p className="max-w-xs text-xs leading-5 text-[#a53630]">{completeError}</p>
                            <button
                              type="button"
                              onClick={() => {
                                setCompleteError(null);
                                if (session) void completeCheckout(session.sessionId);
                              }}
                              className="w-full max-w-xs rounded-lg bg-[#176b4b] px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#10543a]"
                            >
                              Try again
                            </button>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="flex size-12 items-center justify-center rounded-full border border-[#cde0d3] bg-[#f0f7f2]">
                          <CheckCircle2 size={24} className="text-[#176b4b]" />
                        </div>
                        <div className="max-w-sm">
                          <h4 className="text-base font-bold text-[#26332c]">Payment completed</h4>
                          <p className="mt-1 text-xs leading-5 text-[#6a776f]">The merchant payment was executed with the one-time credential, the outcome was reported to Prava, and the session is now closed.</p>
                        </div>
                        <div className="w-full max-w-xs rounded-lg border border-[#e0e6e0] bg-[#fafbf9] px-3 py-2 text-left text-xs">
                          <div className="flex items-center justify-between text-[#718077]"><span>Credential</span><span className="font-mono font-semibold text-[#314239]">•••• {credentialReady.tokenLast4}</span></div>
                          <div className="mt-1 flex items-center justify-between text-[#718077]"><span>State</span><span className="font-semibold text-[#176b4b]">Confirmed &amp; reported</span></div>
                        </div>
                        <button type="button" onClick={handleCredentialReady} className="w-full max-w-xs rounded-lg bg-[#176b4b] px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#10543a]">Return to dashboard</button>
                      </>
                    )}
                  </div>
                )}

                {verificationError && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center space-y-3 bg-white/95 p-6 text-center">
                    <ShieldCheck size={32} className="text-[#176b4b]" />
                    <p className="text-sm font-semibold text-[#26332c]">{/passkey|Windows Hello|biometric|verification/i.test(verificationError) ? 'Passkey verification required' : 'Payment could not be completed'}</p>
                    <p className="max-w-sm text-xs leading-5 text-[#6a776f]">{verificationError}</p>
                  </div>
                )}

                {/* Prava SDK mounts the official sandbox iframe here */}
                <div ref={containerRef} id="prava-checkout-container" className="w-full h-full min-h-[580px] overflow-y-auto" />
              </div>

              <div className="flex shrink-0 items-center justify-between border-t border-[#e8ece7] pt-3 gap-3">
                <div className="flex items-center gap-2 text-[11px] leading-4 text-[#7b867f]">
                  <Lock size={12} className="shrink-0 text-[#176b4b]" />
                  <span>Card details are collected securely by Prava. SubShield never sees or stores them.</span>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="shrink-0 rounded-lg border border-[#d8e0d9] bg-white px-3.5 py-1.5 text-xs font-medium text-[#526259] transition-colors hover:bg-[#f4f7f4] hover:text-[#17201c]"
                >
                  Close
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
