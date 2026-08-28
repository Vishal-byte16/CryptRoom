import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { clearRoomKeyCache, createRoomJoinProof, decryptRoomMessage, encryptRoomMessage, isValidEncryptedMessageEnvelope, type EncryptedMessage } from "@/lib/cryptography";
import QRCode from "qrcode";
import { io, type Socket } from "socket.io-client";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  Flame,
  KeyRound,
  Loader2,
  LockKeyhole,
  MessageCircleMore,
  Moon,
  QrCode,
  SendHorizontal,
  ShieldCheck,
  Sun,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";

type Message = {
  id: string;
  body: string;
  sentAt: number;
  direction: "sent" | "received";
};

type RoomError = { kind: "crypto" | "server" | "connection" | "expired"; message: string; code?: string };
type MessageAck = { ok: true } | { ok: false; code: string; message: string };
type RoomMessageEvent = { envelope: EncryptedMessage; own: boolean };
type MessageAttempt = { attemptId: string; messageId: string; body: string; status: "pending" | "accepted" | "timed_out" | "rejected" };

const TOKEN_PREFIX = "cryptroom:guest:";
const messageFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function tokenKey(roomId: string) {
  return `${TOKEN_PREFIX}${roomId}`;
}

function secretKey(roomId: string) {
  return `cryptroom:secret:${roomId}`;
}

function readSecret(roomId: string): string {
  const fragmentSecret = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  if (fragmentSecret) {
    sessionStorage.setItem(secretKey(roomId), fragmentSecret);
    return fragmentSecret;
  }
  return sessionStorage.getItem(secretKey(roomId)) ?? "";
}

async function participantSequenceKey(roomId: string, guestToken: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(guestToken));
  const tokenHash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `cryptroom:sequence:v2:${roomId}:${tokenHash}`;
}

async function clearParticipantSequence(roomId: string, guestToken: string) {
  localStorage.removeItem(await participantSequenceKey(roomId, guestToken));
}

async function createSequencedEnvelope<T>(roomId: string, guestToken: string, minimum: number, createEnvelope: (sequence: number) => Promise<T>, emitEnvelope: (envelope: T) => void) {
  const key = await participantSequenceKey(roomId, guestToken);
  const allocate = async () => {
    const saved = Number.parseInt(localStorage.getItem(key) ?? "0", 10);
    const next = Math.max(Number.isSafeInteger(saved) ? saved : 0, minimum) + 1;
    localStorage.setItem(key, String(next));
    const envelope = await createEnvelope(next);
    emitEnvelope(envelope);
    return { sequence: next, envelope };
  };
  const locks = navigator.locks;
  if (!locks) throw new Error("This browser cannot safely coordinate encrypted message sequences across tabs.");
  return locks.request(key, { mode: "exclusive" }, allocate);
}

function RoomNotice({ icon: Icon, title, description, action }: { icon: typeof LockKeyhole; title: string; description: string; action?: React.ReactNode }) {
  return (
    <main className="room-shell min-h-screen px-4 py-5 sm:px-6 lg:px-10">
      <div className="mx-auto flex min-h-[82vh] max-w-xl items-center justify-center">
        <section className="notice-card text-center">
          <div className="notice-icon mx-auto"><Icon size={25} strokeWidth={1.8} /></div>
          <h1 className="mt-6 font-serif text-3xl tracking-[-0.03em] text-[#1c2938]">{title}</h1>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#5b6b7d]">{description}</p>
          {action && <div className="mt-7 flex justify-center">{action}</div>}
        </section>
      </div>
    </main>
  );
}

function roomErrorLabel(error: RoomError) {
  if (error.kind === "crypto") return "Encryption check";
  if (error.kind === "connection") return "Connection";
  if (error.kind === "expired") return "Room expired";
  if (error.code === "RATE_LIMITED") return "Rate limit";
  if (error.code === "REPLAY_REJECTED") return "Message rejected";
  if (error.code === "INVALID_ENVELOPE") return "Message format";
  return "Room error";
}

function Countdown({ expiresAt }: { expiresAt: Date }) {
  const [remaining, setRemaining] = useState(Math.max(0, expiresAt.getTime() - Date.now()));

  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(Math.max(0, expiresAt.getTime() - Date.now())), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return <span>{minutes}:{String(seconds).padStart(2, "0")}</span>;
}

export default function Room({ roomId }: { roomId: string }) {
  const [, setLocation] = useLocation();
  const [secret] = useState(() => readSecret(roomId));
  const [guestToken, setGuestToken] = useState(() => sessionStorage.getItem(tokenKey(roomId)) ?? "");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [socketState, setSocketState] = useState<"connecting" | "connected" | "offline" | "error">("connecting");
  const [onlineParticipantCount, setOnlineParticipantCount] = useState(0);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [roomError, setRoomError] = useState<RoomError | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [shareQr, setShareQr] = useState("");
  const [alertsEnabled, setAlertsEnabled] = useState(() => localStorage.getItem("cryptroom:alerts") !== "off");
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("cryptroom:theme") === "dark");
  const [isBurning, setIsBurning] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  const receivedMessageIdsRef = useRef(new Set<string>());
  const attemptsRef = useRef(new Map<string, MessageAttempt>());
  const attemptOrderRef = useRef<string[]>([]);
  const activeAttemptRef = useRef<string | null>(null);
  const draftRef = useRef("");
  const roomSecretReady = secret.length >= 32;
  const utils = trpc.useUtils();
  const beginJoin = trpc.room.beginJoin.useMutation();
  const completeJoin = trpc.room.completeJoin.useMutation();
  const leave = trpc.room.leave.useMutation();
  const burn = trpc.room.burn.useMutation();
  const status = trpc.room.status.useQuery(
    { roomId, guestToken },
    { enabled: Boolean(guestToken), refetchInterval: 12_000, retry: false }
  );

  const beginJoinMutateAsync = beginJoin.mutateAsync;
  const completeJoinMutateAsync = completeJoin.mutateAsync;
  const joinAttemptedRef = useRef(false);

  useEffect(() => {
    if (guestToken || !roomSecretReady) return;
    if (joinAttemptedRef.current) return;
    joinAttemptedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const challenge = await beginJoinMutateAsync({ roomId });
        const proof = await createRoomJoinProof(roomId, secret, challenge.challengeId, challenge.challenge);
        const access = await completeJoinMutateAsync({ roomId, challengeId: challenge.challengeId, proof });
        if (!cancelled) {
          sessionStorage.setItem(tokenKey(access.roomId), access.guestToken);
          setGuestToken(access.guestToken);
        }
      } catch {
        // The mutation state exposes only the server's safe error text.
        // Allow a retry (e.g. if the user reloads secret input) on the next mount.
        if (!cancelled) joinAttemptedRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [beginJoinMutateAsync, completeJoinMutateAsync, guestToken, roomId, roomSecretReady, secret]);

  useEffect(() => {
    if (secret && window.location.hash) window.history.replaceState(null, "", `/room/${roomId}`);
  }, [roomId, secret]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("cryptroom:theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    if (!guestToken || !roomSecretReady || status.isError) return;
    const socket = io(import.meta.env.VITE_API_BASE_URL || undefined, {
      path: "/api/realtime",
      transports: ["polling", "websocket"],
      auth: { roomId, guestToken },
    });
    socketRef.current = socket;
    setSocketState("connecting");

    socket.on("connect", () => { setSocketState("connected"); setRoomError(current => current?.kind === "connection" ? null : current); });
    socket.on("connect_error", () => { setSocketState("error"); setRoomError({ kind: "connection", message: "Unable to establish the protected connection. Retrying…" }); });
    socket.on("disconnect", () => setSocketState("offline"));
    socket.on("room:presence", payload => {
      setOnlineParticipantCount(payload.onlineParticipantCount);
      void utils.room.status.invalidate({ roomId, guestToken });
    });
    socket.on("room:typing", payload => {
      setPartnerTyping(payload.isTyping);
      if (payload.isTyping) window.setTimeout(() => setPartnerTyping(false), 3_200);
    });
    socket.on("room:message", async ({ envelope, own }: RoomMessageEvent) => {
      try {
        if (!isValidEncryptedMessageEnvelope(envelope)) {
          setRoomError({ kind: "crypto", message: "A malformed encrypted message was rejected before decryption." });
          return;
        }
        if (receivedMessageIdsRef.current.has(envelope.messageId)) return;
        receivedMessageIdsRef.current.add(envelope.messageId);
        if (receivedMessageIdsRef.current.size > 256) receivedMessageIdsRef.current.delete(receivedMessageIdsRef.current.values().next().value!);
        const body = await decryptRoomMessage(roomId, secret, envelope);
        setMessages(current => current.some(message => message.id === envelope.messageId) ? current : [...current, { id: envelope.messageId, body, sentAt: envelope.sentAt, direction: own ? "sent" : "received" }]);
        if (!own && document.hidden && alertsEnabled) {
          try {
            if ("Notification" in window && Notification.permission === "granted") new Notification("CryptRoom", { body: "A new private message arrived.", tag: `cryptroom-${roomId}` });
            const AudioContextConstructor = window.AudioContext;
            if (AudioContextConstructor) {
              const context = new AudioContextConstructor();
              const oscillator = context.createOscillator();
              const gain = context.createGain();
              gain.gain.setValueAtTime(0.025, context.currentTime);
              oscillator.frequency.setValueAtTime(660, context.currentTime);
              oscillator.connect(gain).connect(context.destination);
              oscillator.start();
              oscillator.stop(context.currentTime + 0.09);
              window.setTimeout(() => void context.close(), 180);
            }
          } catch { /* Browser alert permissions are optional. */ }
        }
        setPartnerTyping(false);
      } catch {
        setRoomError({ kind: "crypto", message: "A message could not be decrypted. Confirm you both opened the same secure room link." });
      }
    });
    socket.on("room:error", payload => setRoomError({ kind: payload.code === "ROOM_EXPIRED" ? "expired" : "server", code: payload.code, message: payload.message }));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [alertsEnabled, guestToken, roomId, roomSecretReady, secret, status.isError, utils.room.status]);

  const shareLink = useMemo(() => `${window.location.origin}/room/${roomId}#${secret}`, [roomId, secret]);
  const partnerOnline = onlineParticipantCount >= 2;
  const canSend = Boolean(draft.trim() && socketState === "connected" && !isSending);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(shareLink, { errorCorrectionLevel: "M", margin: 1, width: 220, color: { dark: darkMode ? "#e8f4f2" : "#163f43", light: darkMode ? "#152527" : "#ffffff" } })
      .then(value => { if (!cancelled) setShareQr(value); })
      .catch(() => { if (!cancelled) setShareQr(""); });
    return () => { cancelled = true; };
  }, [darkMode, shareLink]);

  const copyShareLink = async () => {
    await navigator.clipboard.writeText(shareLink);
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 2_100);
  };

  const toggleAlerts = async () => {
    const next = !alertsEnabled;
    setAlertsEnabled(next);
    localStorage.setItem("cryptroom:alerts", next ? "on" : "off");
    if (next && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  };

  const handleLeave = async () => {
    try {
      if (guestToken) await leave.mutateAsync({ roomId, guestToken });
    } finally {
      socketRef.current?.disconnect();
      sessionStorage.removeItem(tokenKey(roomId));
      sessionStorage.removeItem(secretKey(roomId));
      clearRoomKeyCache(roomId, secret);
      if (guestToken) await clearParticipantSequence(roomId, guestToken);
      setLocation("/");
    }
  };

  const handleBurn = async () => {
    if (!guestToken || !status.data?.isHost || !window.confirm("Burn this room now? Both participants will lose access immediately.")) return;
    setIsBurning(true);
    try {
      await burn.mutateAsync({ roomId, guestToken });
      await handleLeave();
    } catch {
      setRoomError({ kind: "server", message: "The room could not be burned. Please retry." });
    } finally {
      setIsBurning(false);
    }
  };

  const updateDraft = (value: string) => {
    setDraft(value.slice(0, 1_200));
    draftRef.current = value.slice(0, 1_200);
    if (!socketRef.current || socketState !== "connected") return;
    socketRef.current.emit("room:typing", { isTyping: Boolean(value.trim()) });
    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => socketRef.current?.emit("room:typing", { isTyping: false }), 1_400);
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !socketRef.current || socketState !== "connected") return;
    setIsSending(true);
    setRoomError(null);
    try {
      const prepared = await createSequencedEnvelope(
        roomId,
        guestToken,
        sequenceRef.current,
        sequence => encryptRoomMessage(roomId, secret, body, sequence),
        envelope => {
          const socket = socketRef.current;
          if (!socket || socketState !== "connected") throw new Error("Protected connection is unavailable.");
          const attempt: MessageAttempt = { attemptId: crypto.randomUUID(), messageId: envelope.messageId, body, status: "pending" };
          attemptsRef.current.set(attempt.messageId, attempt);
          attemptOrderRef.current.push(attempt.messageId);
          if (attemptOrderRef.current.length > 256) attemptsRef.current.delete(attemptOrderRef.current.shift()!);
          activeAttemptRef.current = attempt.attemptId;
          let acknowledged = false;
          const acknowledgementTimer = window.setTimeout(() => {
            if (!acknowledged && attemptsRef.current.get(attempt.messageId)?.status === "pending") {
              attempt.status = "timed_out";
              if (activeAttemptRef.current !== attempt.attemptId) return;
              setRoomError({ kind: "connection", message: "Message delivery could not be confirmed. Reconnect and retry." });
              setIsSending(false);
            }
          }, 1_000);
          socket.emit("room:message", envelope, (acknowledgement: MessageAck) => {
            acknowledged = true;
            window.clearTimeout(acknowledgementTimer);
            if (attemptsRef.current.get(attempt.messageId)?.status !== "pending") return;
            if (!acknowledgement?.ok) {
              attempt.status = "rejected";
              if (activeAttemptRef.current === attempt.attemptId) {
                setRoomError({ kind: acknowledgement?.code === "ROOM_EXPIRED" ? "expired" : "server", code: acknowledgement?.code, message: acknowledgement?.message ?? "The message was not accepted by this room." });
                setIsSending(false);
              }
              return;
            }
            attempt.status = "accepted";
            setMessages(current => current.some(message => message.id === envelope.messageId) ? current : [...current, { id: envelope.messageId, body, sentAt: envelope.sentAt, direction: "sent" }]);
            if (activeAttemptRef.current === attempt.attemptId) {
              if (draftRef.current === body) { setDraft(""); draftRef.current = ""; }
              socketRef.current?.emit("room:typing", { isTyping: false });
              setIsSending(false);
            }
          });
        }
      );
      sequenceRef.current = prepared.sequence;
    } catch {
      setRoomError({ kind: "crypto", message: "Your browser could not protect this message. Try a current browser and resend." });
      setIsSending(false);
    }
  };

  if (!roomSecretReady) {
    return <RoomNotice icon={KeyRound} title="Secure link required" description="This room uses a private encryption secret that stays in its secure link. Ask the room creator to send the complete link, not only the Room ID." action={<Button onClick={() => setLocation("/")} className="rounded-full bg-[#1b7a7a] px-5 hover:bg-[#126667]"><ArrowLeft size={16} /> Back to CryptRoom</Button>} />;
  }

  if (!guestToken && (beginJoin.isPending || completeJoin.isPending || (!beginJoin.isError && !completeJoin.isError))) {
    return <RoomNotice icon={Loader2} title="Opening your private room" description="Validating room access and preparing your encrypted connection." />;
  }

  if (beginJoin.isError || completeJoin.isError || status.isError) {
    return <RoomNotice icon={CircleAlert} title="Room unavailable" description={beginJoin.error?.message ?? completeJoin.error?.message ?? status.error?.message ?? "This private room is no longer active."} action={<Button onClick={() => setLocation("/")} className="rounded-full bg-[#1b7a7a] px-5 hover:bg-[#126667]"><ArrowLeft size={16} /> Return home</Button>} />;
  }

  if (!status.data) {
    return <RoomNotice icon={Loader2} title="Checking room status" description="Confirming the room’s participants and protected connection." />;
  }

  return (
    <main className="room-shell min-h-screen p-3 sm:p-5 lg:p-8">
      <div className="mx-auto grid min-h-[calc(100vh-1.5rem)] max-w-[1500px] overflow-hidden rounded-[28px] border border-[#d8e4e6] bg-[#f8fbfa] shadow-[0_30px_90px_rgba(27,55,66,0.13)] lg:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="hidden border-r border-[#dae6e7] bg-[#f0f7f6] p-7 lg:flex lg:flex-col">
          <button onClick={() => setLocation("/")} className="flex w-fit items-center gap-2 text-sm font-medium text-[#415867] transition-colors hover:text-[#1b7a7a]">
            <ArrowLeft size={16} /> Exit room
          </button>
          <div className="mt-14">
            <div className="brand-mark"><LockKeyhole size={16} /></div>
            <p className="mt-5 text-xs font-semibold uppercase tracking-[0.22em] text-[#618088]">Private channel</p>
            <h1 className="mt-2 font-serif text-[2rem] leading-[1.04] tracking-[-0.05em] text-[#1f303c]">A room that leaves no trace.</h1>
          </div>
          <div className="mt-7 rounded-2xl border border-[#d5e5e5] bg-white/75 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#3f5964]"><QrCode size={15} className="text-[#1b7a7a]" /> Scan to join</div>
            <p className="mt-1 text-[11px] leading-4 text-[#71838a]">The QR contains this room’s existing secure link.</p>
            {shareQr && <img src={shareQr} alt="QR code for this room's secure link" className="mx-auto mt-3 h-28 w-28 rounded-lg border border-[#dbe6e5] bg-white p-1" />}
            <Button variant="ghost" size="sm" onClick={copyShareLink} className="mt-2 h-7 w-full rounded-lg text-xs text-[#2b6667] hover:bg-[#e5f2f0]"><Copy size={13} /> {isCopied ? "Copied" : "Copy link"}</Button>
          </div>
          <div className="mt-auto space-y-3 rounded-2xl border border-[#d5e5e5] bg-white/70 p-4">
            <div className="flex gap-3"><ShieldCheck className="mt-0.5 text-[#1b7a7a]" size={17} /><p className="text-xs leading-5 text-[#506773]">Messages are protected in your browser and never written to chat history.</p></div>
            <div className="flex gap-3"><Clock3 className="mt-0.5 text-[#1b7a7a]" size={17} /><p className="text-xs leading-5 text-[#506773]">This room expires automatically in <Countdown expiresAt={status.data.expiresAt} />.</p></div>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-[#fbfcfa]">
          <header className="flex items-center justify-between border-b border-[#e0e9e8] px-4 py-4 sm:px-7">
            <div className="flex min-w-0 items-center gap-3">
              <div className="brand-mark lg:hidden"><LockKeyhole size={16} /></div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#6f8790]">Room</p>
                <h2 className="truncate font-mono text-base font-semibold tracking-[0.16em] text-[#263a45]">{roomId}</h2>
              </div>
              <div className={cn("ml-1 hidden h-2.5 w-2.5 rounded-full sm:block", partnerOnline ? "bg-[#2da786] shadow-[0_0_0_4px_rgba(45,167,134,0.12)]" : "bg-[#b8c5c8]")} />
              <p className="hidden text-xs text-[#70818a] sm:block">{partnerOnline ? "Private connection active" : "Waiting for your guest"}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" onClick={() => void toggleAlerts()} className={cn("rounded-full", alertsEnabled ? "text-[#1b7a7a] hover:bg-[#e8f1f0]" : "text-[#87989d] hover:bg-[#eef3f3]")} aria-label={alertsEnabled ? "Disable private arrival alerts" : "Enable private arrival alerts"} title={alertsEnabled ? "Private arrival alerts on" : "Private arrival alerts off"}>
                <MessageCircleMore size={17} />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setDarkMode(value => !value)} className="rounded-full text-[#526a75] hover:bg-[#e8f1f0]" aria-label="Toggle dark mode">
                {darkMode ? <Sun size={17} /> : <Moon size={17} />}
              </Button>
              <Button variant="ghost" size="sm" onClick={copyShareLink} className="hidden rounded-full text-[#3f5664] hover:bg-[#e8f1f0] sm:flex">
                {isCopied ? <Check size={16} className="text-[#1b7a7a]" /> : <Copy size={16} />} {isCopied ? "Copied" : "Share link"}
              </Button>
              <Button variant="ghost" size="icon" onClick={() => void handleLeave()} className="rounded-full text-[#526a75] hover:bg-[#faeae6] hover:text-[#b64b37]" aria-label="Leave room">
                <X size={18} />
              </Button>
            </div>
          </header>

          <div className="border-b border-[#e5eceb] bg-white/60 px-4 py-3 sm:px-7">
            <div className="flex items-center justify-between gap-3 text-xs text-[#617780]">
              <div className="flex items-center gap-2">
                <span className={cn("inline-block h-2 w-2 rounded-full", socketState === "connected" ? "bg-[#2da786]" : socketState === "connecting" ? "bg-[#d69e3d]" : "bg-[#ce654d]")} />
                <span>{socketState === "connected" ? (partnerOnline ? "You and one guest are present" : "You are securely connected") : socketState === "connecting" ? "Securing connection…" : "Connection interrupted — retrying…"}</span>
                <span className="mx-1 hidden text-[#cad5d7] sm:inline">·</span>
                <span className="hidden items-center gap-1 sm:flex"><UsersRound size={13} /> {status.data.activeParticipantCount}/2 room places used</span>
              </div>
              {status.data.isHost && <Button variant="ghost" size="sm" onClick={() => void handleBurn()} disabled={isBurning} className="h-7 rounded-full px-2 text-[#b64b37] hover:bg-[#faeae6] hover:text-[#9e3527]"><Flame size={14} /> {isBurning ? "Burning…" : "Burn room"}</Button>}
            </div>
          </div>

          {roomError && <div role="alert" className="mx-4 mt-4 flex items-start gap-3 rounded-xl border border-[#f0d2ca] bg-[#fff4f1] px-4 py-3 text-sm text-[#934633] sm:mx-7"><CircleAlert className="mt-0.5 shrink-0" size={17} /><div className="flex-1"><p className="text-xs font-semibold uppercase tracking-[0.08em]">{roomErrorLabel(roomError)}</p><p className="mt-0.5">{roomError.message}</p></div><button aria-label="Dismiss alert" onClick={() => setRoomError(null)}><X size={15} /></button></div>}

          <ScrollArea className="min-h-0 flex-1 px-4 sm:px-7">
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end py-7">
              {messages.length === 0 ? (
                <div className="my-auto py-10 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#e7f4f1] text-[#1b7a7a]"><MessageCircleMore size={24} strokeWidth={1.7} /></div>
                  <h3 className="mt-5 font-serif text-2xl tracking-[-0.035em] text-[#263945]">Your private space is ready.</h3>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#71838a]">Share the secure link. Once your guest arrives, anything said here exists only while this room is open.</p>
                  <Button variant="outline" onClick={copyShareLink} className="mt-5 rounded-full border-[#cfe0df] bg-white px-4 text-[#2c5f62] hover:bg-[#f2f9f7] sm:hidden"><Copy size={15} /> {isCopied ? "Secure link copied" : "Copy secure link"}</Button>
                </div>
              ) : (
                <div className="space-y-5">
                  {messages.map(message => (
                    <article key={message.id} className={cn("message-row", message.direction === "sent" ? "justify-end" : "justify-start")}>
                      <div className={cn("max-w-[85%] rounded-2xl px-4 py-3 shadow-sm sm:max-w-[70%]", message.direction === "sent" ? "rounded-br-md bg-[#1b7a7a] text-white" : "rounded-bl-md border border-[#e0eae9] bg-white text-[#2a3e49]")}>
                        <p className="break-words text-[15px] leading-6">{message.body}</p>
                        <p className={cn("mt-1.5 text-right text-[10px]", message.direction === "sent" ? "text-[#cceee9]" : "text-[#91a0a6]")}>{messageFormatter.format(message.sentAt)}</p>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {partnerTyping && <div className="mt-5 flex items-center gap-2 text-xs text-[#70848a]"><span className="typing-dots"><i /><i /><i /></span> Your guest is writing</div>}
            </div>
          </ScrollArea>

          <footer className="border-t border-[#e0e9e8] bg-white/80 px-4 py-4 sm:px-7 sm:py-5">
            <form onSubmit={sendMessage} className="mx-auto flex max-w-3xl items-end gap-3">
              <div className="relative flex-1">
                <Input value={draft} onChange={event => updateDraft(event.target.value)} placeholder={socketState === "connected" ? "Write privately…" : "Reconnecting to private room…"} disabled={socketState !== "connected"} maxLength={1_200} className="h-12 rounded-xl border-[#d6e3e2] bg-[#fcfefd] pr-14 text-[15px] shadow-none placeholder:text-[#9caab0] focus-visible:border-[#1b7a7a]" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#a1afb2]">{draft.length}/1200</span>
              </div>
              <Button type="submit" disabled={!canSend} className="h-12 rounded-xl bg-[#1b7a7a] px-4 shadow-[0_8px_18px_rgba(27,122,122,0.18)] hover:bg-[#126667] active:scale-[0.97]">
                {isSending ? <Loader2 className="animate-spin" size={18} /> : <SendHorizontal size={18} />}
                <span className="hidden sm:inline">Send</span>
              </Button>
            </form>
            <div className="mx-auto mt-3 flex max-w-3xl items-center justify-center gap-1.5 text-[10px] tracking-[0.04em] text-[#91a0a3]"><LockKeyhole size={11} /> Messages are encrypted before they leave this browser.</div>
          </footer>
        </section>
      </div>
    </main>
  );
}
