import { buildTickets, type Ticket, type TicketHorse } from "./tickets";

type NarTicketHorse = {
  number: number; gate: number; popularity: number; odds: number | null;
  score?: number;
  firstProbability?: number; secondProbability?: number; thirdProbability?: number;
};
type TicketSnapshot = {
  horses: NarTicketHorse[];
  evaluation?: { roleModel?: string; tickets?: string };
  tickets?: Ticket[];
};

/** Use the existing 70:30 generator with the snapshot's own prestart inputs. */
export function withNarTickets<T extends TicketSnapshot>(body: T): T {
  const horses = body.horses;
  const ready = body.evaluation?.roleModel === "ready" && horses.length >= 3
    && new Set(horses.map(h => h.number)).size === horses.length
    && new Set(horses.map(h => h.popularity)).size === horses.length
    && horses.every(h => Number.isInteger(h.number) && h.number > 0
      && Number.isInteger(h.gate) && h.gate >= 1 && h.gate <= 8
      && Number.isInteger(h.popularity) && h.popularity > 0
      && typeof h.odds === "number" && Number.isFinite(h.odds) && h.odds > 0
      && [h.firstProbability, h.secondProbability, h.thirdProbability]
        .every(v => typeof v === "number" && Number.isFinite(v) && v > 0));
  const inputs: TicketHorse[] = ready ? horses.map(h => ({
    ...h, reinScore: h.score ?? 0, marketScore: 0,
  })) : [];
  return {
    ...body,
    evaluation: { ...body.evaluation, tickets: ready ? "ready" : "held" },
    tickets: ready ? buildTickets(inputs) : [],
  } as T;
}
