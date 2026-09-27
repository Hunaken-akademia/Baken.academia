"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { accountJournalKey, accountNoteKey, accountPayload, CLOUD_OWNER_KEY, readLegacyNotes, type AccountData, type HorseNote } from "@/lib/account-data";
import { JOURNAL_KEY, readJournal, type JournalEntry } from "@/lib/prediction-journal";

type CloudContext = AccountData & { ready: boolean; status: string; saveEntries: (entries: JournalEntry[]) => void; saveNote: (horseId: string, note: Omit<HorseNote, "updatedAt">) => void };
const empty: CloudContext = { userId: "", entries: [], notes: {}, ready: false, status: "", saveEntries: () => {}, saveNote: () => {} };
const Context = createContext<CloudContext>(empty);

function fromServer(value: unknown): AccountData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<AccountData>;
  if (typeof data.userId !== "string" || !Array.isArray(data.entries) || !data.notes || typeof data.notes !== "object") return null;
  return { userId: data.userId, entries: readJournal(JSON.stringify(data.entries)), notes: data.notes as Record<string, HorseNote> };
}

function storeLocal(data: AccountData) {
  try {
    localStorage.setItem(accountJournalKey(data.userId), JSON.stringify(data.entries));
    for (const [horseId, note] of Object.entries(data.notes)) localStorage.setItem(accountNoteKey(data.userId, horseId), JSON.stringify(note));
    localStorage.setItem(CLOUD_OWNER_KEY, data.userId);
  } catch {}
}

export function ReinCloudProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AccountData>({ userId: "", entries: [], notes: {} });
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("サーバーから保存データを読み込み中…");
  const [revision, setRevision] = useState(0);
  const [pendingEntries, setPendingEntries] = useState<JournalEntry[] | null>(null);
  const [pendingNotes, setPendingNotes] = useState<Record<string, HorseNote>>({});
  const syncQueue = useRef<Promise<void>>(Promise.resolve());

  const sync = useCallback(async (next: AccountData) => {
    if (!next.userId) return;
    setData(next); setPendingEntries(next.entries); setPendingNotes(next.notes); storeLocal(next); setStatus("サーバーへ保存中…");
    syncQueue.current = syncQueue.current.catch(() => {}).then(async () => {
      try {
        const response = await fetch("/api/account-data", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(accountPayload(next)), cache: "no-store" });
        if (!response.ok) throw new Error("sync failed");
        const canonical = fromServer(await response.json());
        if (!canonical) throw new Error("invalid response");
        setData(canonical); setPendingEntries(canonical.entries); setPendingNotes(canonical.notes); storeLocal(canonical); setStatus("サーバーに保存済み・他の端末と同期しています");
      } catch { setStatus("サーバーに接続できません。端末内に一時保存し、再接続時に同期します。"); }
    });
    await syncQueue.current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/account-data", { cache: "no-store" });
        if (!response.ok) throw new Error("load failed");
        const server = fromServer(await response.json());
        if (!server || cancelled) throw new Error("invalid response");
        const owner = localStorage.getItem(CLOUD_OWNER_KEY);
        const mayImportLegacy = !owner || owner === server.userId;
        const accountEntries = readJournal(localStorage.getItem(accountJournalKey(server.userId)));
        const legacyEntries = mayImportLegacy ? readJournal(localStorage.getItem(JOURNAL_KEY)) : [];
        const byId = new Map<string, JournalEntry>();
        for (const entry of [...accountEntries, ...legacyEntries, ...server.entries]) byId.set(entry.id, entry);
        const merged: AccountData = { ...server, entries: [...byId.values()].sort((a,b) => a.generatedAt.localeCompare(b.generatedAt)).slice(-60), notes: { ...(mayImportLegacy ? readLegacyNotes() : {}), ...server.notes } };
        const cachedNotes: Record<string, HorseNote> = {};
        if (owner === server.userId) {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const prefix = `rein-horse-note-v1:${server.userId}:`;
            if (!key?.startsWith(prefix)) continue;
            const horseId = key.slice(prefix.length);
            try { const value = JSON.parse(localStorage.getItem(key) || "null"); if (/^\d{1,16}$/.test(horseId) && value && typeof value.note === "string" && value.note.length <= 1200) cachedNotes[horseId] = { name: typeof value.name === "string" ? value.name.slice(0,100) : "", note: value.note, watched: value.watched === true, updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString() }; } catch {}
          }
        }
        merged.notes = { ...cachedNotes, ...merged.notes };
        if (!cancelled) { setData(merged); storeLocal(merged); setReady(true); setPendingEntries(merged.entries); setPendingNotes(merged.notes); setStatus("サーバーに保存済み・他の端末と同期しています"); }
        if (JSON.stringify(accountPayload(merged)) !== JSON.stringify(accountPayload(server))) await sync(merged);
      } catch {
        if (!cancelled) { setReady(true); setStatus("サーバーの保存データを読み込めません。再読み込みしてください。"); }
      }
    }
    void load(); return () => { cancelled = true; };
  }, [revision, sync]);

  useEffect(() => {
    if (!ready || !data.userId) return;
    const onStorage = (event: StorageEvent) => { if (event.key === accountJournalKey(data.userId)) { setPendingEntries(null); setRevision(x => x + 1); } };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [data.userId, ready]);

  const saveEntries = useCallback((entries: JournalEntry[]) => { if (ready && data.userId) { setPendingEntries(entries.slice(-60)); void sync({ ...data, entries: entries.slice(-60) }); } }, [data, ready, sync]);
  const saveNote = useCallback((horseId: string, note: Omit<HorseNote, "updatedAt">) => {
    if (!ready || !data.userId) return;
    const next = { ...data, notes: { ...data.notes, [horseId]: { ...note, updatedAt: new Date().toISOString() } } };
    setPendingNotes(next.notes);
    void sync(next);
  }, [data, ready, sync]);
  const value = useMemo(() => ({ ...data, entries: pendingEntries ?? data.entries, notes: pendingNotes, ready, status, saveEntries, saveNote }), [data, pendingEntries, pendingNotes, ready, status, saveEntries, saveNote]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useReinCloudData() { return useContext(Context); }
