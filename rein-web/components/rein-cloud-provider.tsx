"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CLOUD_OWNER_KEY, readLegacyNotes, NOTE_KEY, type HorseNote } from "@/lib/account-data";

type NotesData = { userId: string; notes: Record<string, HorseNote> };
type CloudContext = NotesData & { ready: boolean; status: string; saveNote: (horseId: string, note: Omit<HorseNote, "updatedAt">) => void };
const Context = createContext<CloudContext>({ userId: "", notes: {}, ready: false, status: "", saveNote: () => {} });
function fromServer(value: unknown): NotesData {
  const data = value as NotesData;
  if (!data || typeof data.userId !== "string" || !data.notes || typeof data.notes !== "object") throw new Error("Invalid notes response");
  return { userId: data.userId, notes: data.notes };
}
async function writeNotes(notes: Array<{ horseId: string } & Omit<HorseNote, "updatedAt">>) {
  const response = await fetch("/api/account-data?notes=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: [], notes }), cache: "no-store" });
  if (!response.ok) throw new Error("Note save failed");
  return fromServer(await response.json());
}

export function ReinCloudProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const [data, setData] = useState<NotesData>({ userId: "", notes: {} });
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setReady(false); setStatus("サーバーから馬メモを読み込み中…");
    async function load() {
      try {
        const response = await fetch("/api/account-data?notes=1", { cache: "no-store" });
        if (!response.ok) throw new Error("Notes load failed");
        let server = fromServer(await response.json());
        // Read existing device notes once, scoped to their first signed-in owner.
        // Existing server notes always win. Forecasts are no longer uploaded by clients.
        const imported: Record<string, HorseNote> = {};
        try {
          const owner = localStorage.getItem(CLOUD_OWNER_KEY);
          if (!owner) localStorage.setItem(CLOUD_OWNER_KEY, server.userId);
          if (!owner || owner === server.userId) Object.assign(imported, readLegacyNotes());
          const prefix = `${NOTE_KEY}${server.userId}:`;
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key?.startsWith(prefix)) continue;
            const id = key.slice(prefix.length);
            const value = JSON.parse(localStorage.getItem(key) || "null");
            if (/^\d{1,16}$/.test(id) && value && typeof value.note === "string" && value.note.length <= 1200) imported[id] = { ...value, name: String(value.name ?? "").slice(0, 100), watched: value.watched === true };
          }
        } catch {}
        const missing = Object.entries(imported).filter(([id]) => !server.notes[id]).map(([horseId, note]) => ({ horseId, ...note }));
        if (missing.length) server = await writeNotes(missing.slice(0, 500));
        if (!cancelled) { setData(server); setReady(true); setStatus("馬メモはアカウントに保存され、別の端末でも確認できます。"); }
      } catch {
        if (!cancelled) { setReady(false); setStatus("馬メモを読み込めません。詳細を開き直してください。"); }
      }
    }
    void load(); return () => { cancelled = true; };
  }, [enabled]);
  const saveNote = useCallback((horseId: string, note: Omit<HorseNote, "updatedAt">) => {
    if (!ready || !data.userId) return;
    setStatus("サーバーへ保存中…");
    // Send only the edited horse; another device's unrelated notes cannot be overwritten.
    queue.current = queue.current.catch(() => {}).then(async () => {
      try { setData(await writeNotes([{ horseId, ...note }])); setStatus("サーバーに保存しました。"); }
      catch { setStatus("サーバー保存に失敗しました。通信を確認して、もう一度保存してください。"); }
    });
  }, [ready, data.userId]);
  const value = useMemo(() => ({ ...data, ready, status, saveNote }), [data, ready, status, saveNote]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useReinCloudData() { return useContext(Context); }
