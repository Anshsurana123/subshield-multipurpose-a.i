'use client';

import React, { useState } from 'react';
import { Shield, Sparkles, RefreshCw, CheckCircle2, Lock, ExternalLink, AlertCircle } from 'lucide-react';
import GlowCard from '../shared/GlowCard';

interface GoogleConnectPanelProps {
  onScanComplete: (data: any) => void;
}

export default function GoogleConnectPanel({ onScanComplete }: GoogleConnectPanelProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scanStats, setScanStats] = useState<{ scanned: number; flagged: number } | null>(null);

  const handleConnect = async () => {
    setIsConnecting(true);
    setErrorMsg(null);

    // Pre-open a tab synchronously to avoid browser popup blockers
    const newTab = window.open('about:blank', '_blank');

    try {
      const res = await fetch('/api/auth/browserbase/connect', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'demo-user-id' })
      });
      const data = await res.json();
      
      if (data.success && data.liveUrl) {
        setLiveUrl(data.liveUrl);
        setIsConnected(true);
        if (newTab) {
          newTab.location.href = data.liveUrl;
        } else {
          window.open(data.liveUrl, '_blank');
        }
      } else {
        if (newTab) newTab.close();
        setErrorMsg(data.error || 'Failed to initialize Browserbase session.');
      }
    } catch (err: any) {
      if (newTab) newTab.close();
      console.error('Error connecting via Browserbase:', err);
      setErrorMsg(err.message || 'Network error while initializing Browserbase session.');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleRunScan = async () => {
    setIsScanning(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/scan/gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'demo-user-id' }),
      });
      const data = await res.json();
      if (data.success) {
        setScanStats({ scanned: data.scannedCount || 0, flagged: data.flaggedCount || 0 });
        onScanComplete(data);
      } else {
        setErrorMsg(data.error || 'Scan failed to complete.');
      }
    } catch (err: any) {
      console.error('Scan failed:', err);
      setErrorMsg(err.message || 'Network error during scan.');
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <GlowCard className="p-6 md:p-8 rounded-2xl relative overflow-hidden">
      <div className="absolute top-0 right-0 w-64 h-64 bg-[#176b4b]/5 blur-3xl pointer-events-none rounded-full" />
      
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 relative z-10">
        <div className="space-y-2 max-w-xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#e8f2ec] border border-[#cde0d3] text-[#176b4b] text-xs font-mono">
            <Shield className="w-3.5 h-3.5" />
            <span>REAL-WORLD AUTOMATION ENGINE</span>
          </div>
          <h2 className="text-2xl font-bold text-[#17201c] tracking-tight">
            Connect Google Account to Scan Subscriptions
          </h2>
          <p className="text-[#68756d] text-sm leading-relaxed">
            SubShield opens a sandboxed cloud browser pre-navigated to Google Sign-In. Authenticate once, and SubShield will monitor your Gmail & Google Subscriptions page automatically.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3 w-full md:w-auto">
          {!isConnected ? (
            <button
              onClick={handleConnect}
              disabled={isConnecting}
              className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-[#176b4b] hover:bg-[#10543a] text-white font-semibold text-sm shadow-sm transition-all flex items-center justify-center gap-2.5 disabled:opacity-50 cursor-pointer"
            >
              {isConnecting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Launching Google Sign-In...</span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Connect Google Account</span>
                </>
              )}
            </button>
          ) : (
            <div className="flex flex-col sm:flex-row gap-3 w-full">
              {liveUrl && (
                <a
                  href={liveUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="px-5 py-3.5 rounded-xl bg-[#fafbf9] hover:bg-[#f4f7f4] text-[#176b4b] font-bold text-xs font-mono border border-[#cde0d3] flex items-center justify-center gap-2 shadow-sm"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>Open Google Sign-In Screen</span>
                </a>
              )}
              <button
                onClick={handleRunScan}
                disabled={isScanning}
                className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-[#176b4b] hover:bg-[#10543a] text-white font-bold text-sm shadow-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
              >
                {isScanning ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Scanning Inbox & Google Subs...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>Run Scan Now</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {isConnected && (
        <div className="mt-5 p-4 rounded-xl bg-[#f0f7f2] border border-[#cde0d3] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-[#176b4b]">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-[#176b4b]" />
            <span>Google Sign-In Session Ready! Please complete sign-in in the opened browser tab.</span>
          </div>
          {liveUrl && (
            <a
              href={liveUrl}
              target="_blank"
              rel="noreferrer"
              className="underline font-bold font-mono shrink-0 hover:text-[#10543a]"
            >
              Re-open Google Sign-In Tab →
            </a>
          )}
        </div>
      )}

      {errorMsg && (
        <div className="mt-4 p-3 rounded-xl bg-[#fdf4f3] border border-[#efd3d0] flex items-center gap-2.5 text-xs text-[#a53630]">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {scanStats && (
        <div className="mt-6 pt-4 border-t border-[#e8ece7] flex items-center gap-6 text-xs text-[#68756d] font-mono">
          <div className="flex items-center gap-2 text-[#176b4b]">
            <CheckCircle2 className="w-4 h-4" />
            <span>Scanned: <strong>{scanStats.scanned}</strong> active notifications</span>
          </div>
          <div>
            <span>Flagged for Action: <strong className="text-[#9b6300]">{scanStats.flagged}</strong></span>
          </div>
        </div>
      )}
    </GlowCard>
  );
}
