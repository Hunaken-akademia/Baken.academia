import { JOURNAL_KEY, JOURNAL_LIMIT, readJournal, type JournalEntry } from "./prediction-journal";

export type HorseNote = { name: string; note: string; watched: boolean; updatedAt: string };
export type AccountData = { userId: string; entries: JournalEntry[]; notes: Record<string, HorseNote> };
export const CLOUD_OWNER_KEY = "rein-cloud-migration-owner-v1";
export const NOTE_KEY = "rein-horse-note-v1:";

export function accountJournalKey(userId: string) { return `${JOURNAL_KEY}:${userId}`; }
export function accountNoteKey(userId: string, horseId: string) { return `${NOTE_KEY}${userId}:${horseId}`; }

export function readLegacyNotes(): Record<string, HorseNote> {
  const notes: Record<string, HorseNote> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const id = key?.startsWith(NOTE_KEY) ? key.slice(NOTE_KEY.length) : "";
      if (!key || !/^\d{1,16}$/.test(id)) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        if (value && typeof value.note === "string" && value.note.length <= 1200) notes[id] = { name: typeof value.name === "string" ? value.name.slice(0,100) : "", note: value.note, watched: value.watched === true, updatedAt: typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : new Date(0).toISOString() };
      } catch {}
    }
  } catch {}
  return notes;
}

export function accountPayload(data: AccountData) {
  return { entries: data.entries.slice(-JOURNAL_LIMIT).map(({ finishers, ...prediction }) => ({ prediction, result: finishers ?? null })), notes: Object.entries(data.notes).map(([horseId, note]) => ({ horseId, ...note })) };
}
