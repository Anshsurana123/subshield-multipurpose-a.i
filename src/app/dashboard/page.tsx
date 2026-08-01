'use client';

import { useState } from 'react';
import Header from '@/components/layout/Header';
import SubscriptionHealthDashboard from '@/components/discover/SubscriptionHealthDashboard';
import GoogleConnectPanel from '@/components/discover/GoogleConnectPanel';
import DecisionCard from '@/components/decide/DecisionCard';
import NegotiationTranscript from '@/components/decide/NegotiationTranscript';
import NegotiationControls from '@/components/decide/NegotiationControls';
import PravaMandatePanel from '@/components/act/PravaMandatePanel';
import PriceTrackerPanel from '@/components/act/PriceTrackerPanel';
import OrderConsolePanel from '@/components/act/OrderConsolePanel';
import PravaCheckoutModal from '@/components/act/PravaCheckoutModal';
import CheckoutResultBanner from '@/components/act/CheckoutResultBanner';
import MoneySavedTicker from '@/components/metrics/MoneySavedTicker';
import { useSubShieldStore } from '@/store/subscription-store';
import { Alternative, CheckoutOutcome, Decision, Mandate, NegotiationEvent, Subscription } from '@/lib/types';

export default function DashboardPage() {
  const store = useSubShieldStore();
  const [checkoutOutcome, setCheckoutOutcome] = useState<CheckoutOutcome | null>(null);
  const [activePhase, setActivePhase] = useState<'DISCOVER' | 'DECIDE' | 'ACT'>('DISCOVER');

  const handleScanComplete = (scanData: any) => {
    if (scanData.subscriptions) {
      store.setSubscriptions(scanData.subscriptions);
      store.setAuditPhase('complete');

      if (scanData.decisions) {
        store.setDecisions(scanData.decisions);
      }

      if (scanData.subscriptions.length > 0) {
        const first = scanData.subscriptions[0];
        store.selectSubscription(first);
        fetchAlternatives(first);
      }
    }
  };

  const fetchAlternatives = async (sub: Subscription) => {
    try {
      const res = await fetch(`/api/alternatives?vendor=${encodeURIComponent(sub.vendor)}&currentPrice=${sub.currentPrice}`);
      const alts = await res.json();
      if (Array.isArray(alts)) {
        store.setAlternatives(alts);
      }
    } catch (e) {
      console.error('Fetch alternatives error:', e);
    }
  };

  const handleSelectSubscription = (id: string) => {
    const sub = store.subscriptions.find((s) => s.id === id);
    if (sub) {
      store.selectSubscription(sub);
      fetchAlternatives(sub);
      setActivePhase('DECIDE');
    }
  };

  const handleStartNegotiation = async () => {
    const sub = store.selectedSubscription;
    if (!sub) return;

    store.setIsNegotiating(true);
    store.clearNegotiationEvents();
    setActivePhase('DECIDE');

    try {
      const response = await fetch('/api/negotiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscriptionId: sub.id,
          vendor: sub.vendor,
          currentPrice: sub.currentPrice,
          merchantDomain: sub.merchantDomain,
          alternatives: store.alternatives,
        }),
      });

      if (!response.body) {
        throw new Error('No SSE response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let targetFinalPrice = sub.currentPrice * 0.7;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter((l) => l.startsWith('data: '));

        for (const line of lines) {
          try {
            const event: NegotiationEvent = JSON.parse(line.slice(6));
            store.addNegotiationEvent(event);
            if (event.type === 'offer' || event.type === 'result') {
              const match = event.message.match(/\$(\d+(?:\.\d+)?)/);
              if (match) {
                targetFinalPrice = parseFloat(match[1]);
              }
            }
          } catch {
            // ignore JSON parse errors
          }
        }
      }

      store.setIsNegotiating(false);
      store.setNegotiationComplete(true);
      store.setNegotiationResult({
        originalPrice: sub.currentPrice,
        finalPrice: targetFinalPrice,
        savings: sub.currentPrice - targetFinalPrice,
        vendor: sub.vendor,
        subscriptionId: sub.id,
      });
      setActivePhase('ACT');
    } catch (e) {
      console.error('Negotiation error:', e);
      store.setIsNegotiating(false);
    }
  };

  const handleAcceptOffer = async () => {
    const result = store.negotiationResult;
    const sub = store.selectedSubscription;
    if (!result || !sub) return;

    setActivePhase('ACT');

    try {
      const res = await fetch('/api/prava/create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user_demo_001',
          userEmail: 'demo@subshield.app',
          vendorName: result.vendor,
          vendorDomain: sub.merchantDomain,
          amount: result.finalPrice,
          currency: 'USD',
          description: `Negotiated SubShield mandate for ${result.vendor}`,
        }),
      });

      const session = await res.json();
      store.setActivePravaSession(session);
      store.setIsCheckoutOpen(true);
    } catch (e) {
      console.error('Create Prava session failed:', e);
      store.setActivePravaSession({
        sessionId: `sess_${Date.now()}`,
        sessionToken: 'token_demo',
        iframeUrl: '',
        orderId: `ord_${Math.random().toString(36).substring(7)}`,
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      });
      store.setIsCheckoutOpen(true);
    }
  };

  const handleAcceptSwitch = (sub: Subscription, alt: Alternative) => {
    const annualSavings = (sub.currentPrice - alt.price) * 12;
    store.addSavings(annualSavings);
    store.incrementCancelledUnused();

    const newMandate: Mandate = {
      id: `m_${Date.now()}`,
      sessionId: `sess_${Date.now()}`,
      vendor: alt.name,
      merchantDomain: sub.merchantDomain,
      amount: alt.price,
      currency: 'USD',
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      negotiatedFrom: sub.currentPrice,
    };

    store.addMandate(newMandate);
    setActivePhase('ACT');
  };

  const handleCheckoutComplete = (outcome: CheckoutOutcome) => {
    setCheckoutOutcome(outcome);
    store.setIsCheckoutOpen(false);
    const paymentReported = outcome.reportedToVisa && outcome.status === 'completed';

    if (store.negotiationResult && store.selectedSubscription) {
      const annualSavings = store.negotiationResult.savings * 12;

      const newMandate: Mandate = {
        id: `m_${Date.now()}`,
        sessionId: outcome.sessionId || 'sess_123',
        vendor: store.negotiationResult.vendor,
        merchantDomain: store.selectedSubscription.merchantDomain,
        amount: store.negotiationResult.finalPrice,
        currency: 'USD',
        status: paymentReported ? 'active' : 'pending-checkout',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        negotiatedFrom: store.negotiationResult.originalPrice,
        checkoutOutcome: outcome,
      };

      store.addMandate(newMandate);
      if (paymentReported) {
        store.addSavings(annualSavings);
        store.incrementNegotiatedDiscounts();
        store.incrementBlockedHikes();
      }

      if (paymentReported) {
        store.setSubscriptions(
          store.subscriptions.map((s) =>
            s.id === store.selectedSubscription?.id
              ? { ...s, status: 'healthy', previousPrice: s.currentPrice, currentPrice: store.negotiationResult!.finalPrice }
              : s
          )
        );
      }
    }

    setTimeout(() => {
      setCheckoutOutcome(null);
    }, 6000);
  };

  const currentDecision = store.decisions.find(
    (d) => d.subscriptionId === store.selectedSubscription?.id
  );

  return (
    <div className="min-h-screen bg-mesh text-[#17201c]">
      <Header
        activePhase={activePhase}
        notifications={store.notifications}
        onScanClick={() => {
          store.setAuditPhase('scanning_gmail');
        }}
        onDismissNotification={(id) => store.dismissNotification(id)}
      />

      <main className="mx-auto w-full max-w-[1440px] px-4 py-7 sm:px-6 sm:py-10 lg:px-8 space-y-8">
        {checkoutOutcome && <CheckoutResultBanner outcome={checkoutOutcome} />}

        <GoogleConnectPanel onScanComplete={handleScanComplete} />

        <PriceTrackerPanel />

        <OrderConsolePanel />

        {store.subscriptions.length > 0 && (
          <>
            <section className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <p className="eyebrow">AUTOMATED WORKSPACE</p>
                <h2 className="mt-1 text-3xl font-bold tracking-tight text-[#17201c]">Discovered Subscriptions & AI Actions</h2>
              </div>
              <p className="max-w-sm text-sm text-[#68756d]">
                Review discovered subscriptions, AI-classified replacement difficulty, and recommended action paths.
              </p>
            </section>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
              <section className="xl:col-span-7">
                <SubscriptionHealthDashboard
                  subscriptions={store.subscriptions}
                  onNegotiate={handleSelectSubscription}
                  selectedId={store.selectedSubscription?.id}
                />
              </section>

              <section className="flex min-h-[520px] flex-col gap-5 xl:col-span-5">
                {currentDecision && store.selectedSubscription && (
                  <DecisionCard
                    decision={currentDecision}
                    subscription={store.selectedSubscription}
                    alternative={currentDecision.alternative}
                    onAcceptSwitch={handleAcceptSwitch}
                    onStartNegotiation={handleStartNegotiation}
                  />
                )}

                <div className="h-[220px]">
                  <NegotiationTranscript
                    events={store.negotiationEvents}
                    isActive={store.isNegotiating}
                  />
                </div>

                <div className="flex-1">
                  <NegotiationControls
                    subscription={store.selectedSubscription}
                    alternatives={store.alternatives}
                    negotiationEvents={store.negotiationEvents}
                    isNegotiating={store.isNegotiating}
                    negotiationComplete={store.negotiationComplete}
                    finalPrice={store.negotiationResult?.finalPrice || null}
                    onStartNegotiation={handleStartNegotiation}
                    onAcceptOffer={handleAcceptOffer}
                    onDeclineAndSwitch={(alt) => {
                      if (store.selectedSubscription) handleAcceptSwitch(store.selectedSubscription, alt);
                    }}
                  />
                </div>
              </section>
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
              <section className="min-h-[210px] lg:col-span-4">
                <MoneySavedTicker
                  totalSaved={store.totalSaved}
                  blockedHikes={store.blockedHikes}
                  cancelledUnused={store.cancelledUnused}
                  negotiatedDiscounts={store.negotiatedDiscounts}
                />
              </section>

              <section className="min-h-[210px] lg:col-span-8">
                <PravaMandatePanel mandates={store.mandates} />
              </section>
            </div>
          </>
        )}

        <PravaCheckoutModal
          isOpen={store.isCheckoutOpen}
          onClose={() => store.setIsCheckoutOpen(false)}
          session={store.activePravaSession}
          vendor={store.negotiationResult?.vendor || store.selectedSubscription?.vendor || ''}
          originalPrice={store.negotiationResult?.originalPrice || store.selectedSubscription?.currentPrice || 0}
          negotiatedPrice={store.negotiationResult?.finalPrice || 0}
          onCheckoutComplete={handleCheckoutComplete}
        />
      </main>
    </div>
  );
}
