import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createRoomSecret, createRoomSecretVerifier } from "@/lib/cryptography";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ArrowRight, Camera, CircleAlert, KeyRound, LockKeyhole, Moon, ShieldCheck, Sparkles, Sun, TimerReset, UsersRound, X } from "lucide-react";
import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

const TOKEN_PREFIX = "cryptroom:guest:";

function normalizeJoinInput(value: string): { roomId: string; secret: string } {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/room\/([A-Z0-9]{6})/i);
    return { roomId: match?.[1]?.toUpperCase() ?? "", secret: url.hash.replace(/^#/, "") };
  } catch {
    return { roomId: trimmed.toUpperCase().replace(/[^A-Z0-9]/g, ""), secret: "" };
  }
}

export default function Home() {
  const [joinInput, setJoinInput] = useState("");
  const [joinSecret, setJoinSecret] = useState("");
  const [needsSecret, setNeedsSecret] = useState(false);
  const [inputError, setInputError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("cryptroom:theme") === "dark");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanFrameRef = useRef<number | null>(null);
  const create = trpc.room.create.useMutation();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("cryptroom:theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const stopScanning = () => {
    if (scanFrameRef.current) cancelAnimationFrame(scanFrameRef.current);
    scanFrameRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    setScanning(false);
  };

  const enterRoom = (roomId: string, secret: string) => window.location.assign(`/room/${roomId}#${secret}`);

  const tryJoinFromText = (value: string) => {
    const { roomId, secret } = normalizeJoinInput(value);
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(roomId)) return false;
    if (secret) {
      enterRoom(roomId, secret);
      return true;
    }
    return false;
  };

  const startScanning = async () => {
    setScanError("");
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      const canvas = canvasRef.current ?? document.createElement("canvas");
      canvasRef.current = canvas;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const tick = () => {
        const video = videoRef.current;
        if (!video || !context || video.readyState !== video.HAVE_ENOUGH_DATA) {
          scanFrameRef.current = requestAnimationFrame(tick);
          return;
        }
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code?.data && tryJoinFromText(code.data)) {
          stopScanning();
          return;
        }
        scanFrameRef.current = requestAnimationFrame(tick);
      };
      scanFrameRef.current = requestAnimationFrame(tick);
    } catch {
      setScanError("Camera access was denied or is unavailable. You can paste the link instead.");
      setScanning(false);
    }
  };

  useEffect(() => () => stopScanning(), []);

  const createNewRoom = async () => {
    const secret = createRoomSecret();
    try {
      const room = await create.mutateAsync({ secretVerifier: await createRoomSecretVerifier(secret) });
      sessionStorage.setItem(`${TOKEN_PREFIX}${room.roomId}`, room.guestToken);
      const link = `${window.location.origin}/room/${room.roomId}#${secret}`;
      try { await navigator.clipboard.writeText(link); } catch { /* clipboard access may be blocked; room still opens normally */ }
      enterRoom(room.roomId, secret);
    } catch {
      // The mutation state supplies a safe, user-facing error below.
    }
  };

  const joinRoom = () => {
    const { roomId, secret } = normalizeJoinInput(joinInput);
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(roomId)) {
      setInputError("Enter a six-character Room ID or paste the secure room link.");
      return;
    }
    const privateKey = secret || joinSecret.trim();
    if (!privateKey || !/^[A-Za-z0-9_-]{32,128}$/.test(privateKey)) {
      setNeedsSecret(true);
      setInputError("Enter the room’s private key or paste the full secure room link. The key stays in your browser.");
      return;
    }
    enterRoom(roomId, privateKey);
  };

  return (
    <main className="landing-shell min-h-screen overflow-hidden text-[#263944]">
      <nav className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-6 sm:px-8 lg:px-10">
        <a href="/" className="flex items-center gap-3" aria-label="CryptRoom home">
          <span className="brand-mark"><LockKeyhole size={17} /></span>
          <span className="font-serif text-xl font-semibold tracking-[-0.04em] text-[#1e3039]">CryptRoom</span>
        </a>
        <div className="flex items-center gap-3 text-xs font-medium text-[#6d8087]"><span className="hidden sm:inline"><span className="inline-block h-2 w-2 rounded-full bg-[#36a17e]" /> Private by design</span><button onClick={() => setDarkMode(value => !value)} className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#d5e5e5] bg-white/70 text-[#3f6570] hover:bg-[#e6f2f0]" aria-label="Toggle dark mode">{darkMode ? <Sun size={15} /> : <Moon size={15} />}</button></div>
      </nav>

      <section className="relative mx-auto grid w-full max-w-7xl gap-12 px-5 pb-20 pt-10 sm:px-8 sm:pt-16 lg:grid-cols-[1.04fr_0.96fr] lg:items-center lg:gap-20 lg:px-10 lg:pb-28">
        <div className="relative z-10 max-w-2xl">
          <p className="section-eyebrow"><Sparkles size={14} /> Ephemeral chat, considered</p>
          <h1 className="mt-6 font-serif text-[3.25rem] leading-[0.94] tracking-[-0.065em] text-[#20313c] sm:text-7xl lg:text-[5.4rem]">A private room,<br /><em>right now.</em></h1>
          <p className="mt-7 max-w-xl text-[1.04rem] leading-7 text-[#627681] sm:text-lg">Create a calm, encrypted space for two. Messages are encrypted in your browser, relayed as encrypted data, and are never stored as chat history.</p>
          <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-[#526a73]"><span className="inline-flex items-center gap-2"><ShieldCheck size={17} className="text-[#1b7a7a]" /> Browser-protected messages</span><span className="inline-flex items-center gap-2"><TimerReset size={17} className="text-[#1b7a7a]" /> Auto-expiring rooms</span></div>
        </div>

        <div className="relative z-10 mx-auto w-full max-w-lg">
          <div className="landing-card rounded-[26px] p-5 sm:p-7">
            <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#1b7a7a]">Start securely</p><h2 className="mt-2 font-serif text-3xl tracking-[-0.045em] text-[#263943]">Open a private room</h2></div><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#e7f4f1] text-[#1b7a7a]"><KeyRound size={19} /></span></div>
            <p className="mt-3 text-sm leading-6 text-[#70828a]">We create a room and copy its secure link to your clipboard, then take you straight in.</p>
            {create.error && <div className="mt-5 flex items-start gap-2 rounded-xl bg-[#fff2ee] px-3 py-3 text-sm text-[#a44936]"><CircleAlert size={16} className="mt-0.5 shrink-0" />{create.error.message}</div>}
            <Button onClick={() => void createNewRoom()} disabled={create.isPending} className="mt-7 h-12 w-full rounded-xl bg-[#1b7a7a] text-sm shadow-[0_9px_20px_rgba(27,122,122,0.2)] hover:bg-[#126667] active:scale-[0.98]">
              {create.isPending ? "Preparing your room…" : "Create a room"}<ArrowRight size={17} />
            </Button>
            <div className="my-7 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#a0afb1]"><span className="h-px flex-1 bg-[#e1e9e8]" />or<span className="h-px flex-1 bg-[#e1e9e8]" /></div>
            <label htmlFor="room-link" className="text-sm font-medium text-[#415d69]">Join someone’s room</label>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
              <Input id="room-link" value={joinInput} onChange={event => { setJoinInput(event.target.value); setInputError(""); const { secret } = normalizeJoinInput(event.target.value); setNeedsSecret(!secret && event.target.value.trim().length > 0); }} onKeyDown={event => { if (event.key === "Enter") joinRoom(); }} placeholder="Room ID or secure link" className={cn("h-11 rounded-xl border-[#d6e4e4] bg-[#fcfefd] text-sm placeholder:text-[#a1b0b2] focus-visible:border-[#1b7a7a]", inputError && "border-[#de8a76]")} />
              <Button type="button" onClick={() => void startScanning()} variant="outline" className="h-11 rounded-xl border-[#c9dedc] px-3 text-[#1b6668] hover:bg-[#eef8f5]" aria-label="Scan a QR code to join"><Camera size={17} /></Button>
              <Button type="button" onClick={joinRoom} variant="outline" className="h-11 rounded-xl border-[#c9dedc] px-4 text-[#1b6668] hover:bg-[#eef8f5]"><ArrowRight size={17} /></Button>
            </div>
            {needsSecret && <Input aria-label="Private room key" value={joinSecret} onChange={event => { setJoinSecret(event.target.value); setInputError(""); }} onKeyDown={event => { if (event.key === "Enter") joinRoom(); }} placeholder="Private key (only needed with a Room ID)" className="mt-2 h-10 rounded-xl border-[#d6e4e4] bg-[#fcfefd] text-xs placeholder:text-[#a1b0b2] focus-visible:border-[#1b7a7a]" autoFocus />}
            {inputError && <p className="mt-2 text-xs leading-5 text-[#b15640]">{inputError}</p>}
            <p className="mt-3 text-[11px] leading-5 text-[#97a6aa]">Paste the full secure link, scan the host’s QR code, or enter a Room ID and private key separately. The key never leaves your browser.</p>
          </div>
          <div className="absolute -right-7 -top-7 -z-10 hidden h-36 w-36 rounded-full bg-[#d9efe9] blur-2xl sm:block" />
          <div className="absolute -bottom-8 -left-8 -z-10 hidden h-32 w-32 rounded-full bg-[#f1dfbc] blur-2xl sm:block" />
        </div>
      </section>

      {scanning && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-6">
          <div className="relative w-full max-w-sm overflow-hidden rounded-2xl bg-black">
            <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
            <div className="pointer-events-none absolute inset-6 rounded-xl border-2 border-white/70" />
          </div>
          <p className="mt-4 max-w-sm text-center text-sm text-white/80">Point your camera at the host’s QR code.</p>
          {scanError && <p className="mt-2 max-w-sm text-center text-sm text-[#f3a58e]">{scanError}</p>}
          <Button onClick={stopScanning} variant="outline" className="mt-5 h-10 rounded-xl border-white/30 bg-transparent text-white hover:bg-white/10"><X size={16} /> Cancel</Button>
        </div>
      )}

      <section className="relative z-10 mx-auto grid max-w-7xl gap-4 px-5 pb-12 sm:grid-cols-3 sm:px-8 lg:px-10 lg:pb-16">
        {[{ icon: LockKeyhole, title: "No account required", copy: "Step into a private room without sharing a name, email, or profile." }, { icon: UsersRound, title: "Only two people", copy: "Each room deliberately holds one conversation between two participants." }, { icon: TimerReset, title: "Gone when you leave", copy: "The room state expires automatically. Messages are never kept." }].map(item => <article key={item.title} className="feature-card"><item.icon size={18} className="text-[#1b7a7a]" /><h3>{item.title}</h3><p>{item.copy}</p></article>)}
      </section>

      <section className="relative z-10 mx-auto grid max-w-7xl gap-5 px-5 pb-16 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:px-10 lg:pb-24">
        <div className="feature-card"><ShieldCheck size={20} className="text-[#1b7a7a]" /><h2>Encrypted in your browser</h2><p>Your private key stays in the browser. The server verifies guest access, then relays encrypted envelopes without keeping a chat history.</p></div>
        <ol className="feature-card grid gap-3 text-sm text-[#617780] sm:grid-cols-5" aria-label="How CryptRoom works">
          {["Create a room", "Share the private link", "Two people connect", "Messages encrypt in-browser", "Room expires"].map((step, index) => <li key={step} className="flex gap-2"><span className="font-mono text-xs font-bold text-[#1b7a7a]">0{index + 1}</span><span>{step}</span></li>)}
        </ol>
      </section>
    </main>
  );
}
