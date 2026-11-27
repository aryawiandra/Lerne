"use client";

import { useActionState, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { issueToken, redeemToken, type TokenState } from "@/app/actions/sessions";
import { FormMessage } from "@/components/ActionForm";

type Phase = "start" | "end";
const BUTTON = "rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60";
const SCAN_INTERVAL_MS = 400;

function useSecondsLeft(expiresAt?: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000)) : 0;
}

export function QrPanel({ sessionId, phase }: { sessionId: string; phase: Phase }) {
  const [state, action, pending] = useActionState<TokenState, FormData>(issueToken, {});
  const secondsLeft = useSecondsLeft(state.expiresAt);
  const live = Boolean(state.token) && secondsLeft > 0;

  return (
    <div className="space-y-3">
      <form action={action}>
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="phase" value={phase} />
        <button type="submit" disabled={pending} className={BUTTON}>
          {state.token ? "New code" : phase === "start" ? "Show start QR" : "Show end QR"}
        </button>
      </form>
      <FormMessage state={state} />
      {state.token && state.qrDataUrl && (
        <div className={live ? "" : "opacity-30"}>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated server-side */}
          <img src={state.qrDataUrl} alt={`Session ${phase} QR code`} width={280} height={280} />
          <p className="mt-2 text-xs text-slate-500">
            {live ? `Expires in ${secondsLeft}s` : "Expired — generate a new code"}
          </p>
          <code data-testid="session-token" className="mt-1 block break-all rounded bg-slate-100 p-2 text-xs">
            {state.token}
          </code>
        </div>
      )}
    </div>
  );
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

const noopSubscribe = () => () => undefined;
const browserCanScan = () => "BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia);

export function RedeemPanel({ sessionId, phase }: { sessionId: string; phase: Phase }) {
  const [state, action, pending] = useActionState(redeemToken, {});
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const canScan = useSyncExternalStore(noopSubscribe, browserCanScan, () => false);

  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    const Detector = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    const detector = new Detector({ formats: ["qr_code"] });

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        stream = s;
        if (!videoRef.current) return;
        videoRef.current.srcObject = s;
        void videoRef.current.play();
        timer = window.setInterval(async () => {
          if (!videoRef.current) return;
          const codes = await detector.detect(videoRef.current).catch(() => []);
          if (codes[0]?.rawValue && inputRef.current) {
            inputRef.current.value = codes[0].rawValue;
            setScanning(false);
            formRef.current?.requestSubmit();
          }
        }, SCAN_INTERVAL_MS);
      })
      .catch(() => {
        setScanError("Camera not available — paste the code instead.");
        setScanning(false);
      });

    return () => {
      if (timer) window.clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning]);

  return (
    <div className="space-y-3">
      {canScan && (
        <button type="button" onClick={() => setScanning((s) => !s)} className="inline-flex min-h-11 items-center text-sm text-teal-800 underline">
          {scanning ? "Stop camera" : "Scan QR with camera (experimental)"}
        </button>
      )}
      {scanning && <video ref={videoRef} muted playsInline className="w-full max-w-xs rounded border" />}
      {scanError && <p className="text-sm text-amber-800">{scanError}</p>}
      <form ref={formRef} action={action} className="space-y-2">
        <input type="hidden" name="sessionId" value={sessionId} />
        <label className="block text-sm" htmlFor="token">
          Session code
        </label>
        <textarea
          id="token"
          ref={inputRef}
          name="token"
          required
          rows={2}
          className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
        />
        <button type="submit" disabled={pending} className={BUTTON}>
          {phase === "start" ? "Start session" : "End session"}
        </button>
      </form>
      <FormMessage state={state} />
    </div>
  );
}
