import type { Difficulty, GameMode } from '../game/constants';

export interface LeaderboardEntry {
  id: string;
  name: string;
  mode: GameMode;
  score: number;
  bestRally: number;
  maxPhase: number;
  perfectHits: number;
  difficulty: string;
  matchScore?: string;
  createdAt: string;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  source: 'server' | 'local';
  error?: string;
}

export interface SubmitScorePayload {
  name: string;
  mode: GameMode;
  score: number;
  bestRally: number;
  maxPhase: number;
  perfectHits: number;
  difficulty: Difficulty | 'overdrive';
  matchScore?: string;
}

export interface SubmitScoreResponse {
  ok: boolean;
  source: 'server' | 'local';
  entry?: LeaderboardEntry;
  rank?: number | null;
  isTopRecord?: boolean;
  entries?: LeaderboardEntry[];
  error?: string;
}

const LOCAL_STORAGE_KEY = 'robot_pong_leaderboard_v1';

const FALLBACK_SEEDS: Record<GameMode, LeaderboardEntry[]> = {
  arcade: [],
  duel: [],
};

function readLocalStore(): Record<GameMode, LeaderboardEntry[]> {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return structuredClone(FALLBACK_SEEDS);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.arcade) && Array.isArray(parsed?.duel)) {
      const stripFake = (list: LeaderboardEntry[]) =>
        list.filter(
          (e) =>
            typeof e?.id !== 'string' ||
            (!e.id.startsWith('local-arc-') &&
              !e.id.startsWith('local-duel-') &&
              !e.id.startsWith('seed-'))
        );
      return {
        arcade: stripFake(parsed.arcade),
        duel: stripFake(parsed.duel),
      };
    }
  } catch {
    // Ignore storage quota or corrupt local JSON
  }
  return structuredClone(FALLBACK_SEEDS);
}

function writeLocalStore(data: Record<GameMode, LeaderboardEntry[]>): void {
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage restrictions
  }
}

function sortEntries(list: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...list].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.bestRally !== a.bestRally) return b.bestRally - a.bestRally;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = 2500): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchLeaderboard(mode: GameMode, limit = 15): Promise<LeaderboardResponse> {
  try {
    const res = await fetchWithTimeout(`/api/leaderboard?mode=${encodeURIComponent(mode)}&limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.ok || !Array.isArray(json.entries)) {
      throw new Error(json.error || 'Invalid leaderboard payload');
    }
    return { entries: json.entries as LeaderboardEntry[], source: 'server' };
  } catch {
    const local = readLocalStore();
    return {
      entries: sortEntries(local[mode] || []).slice(0, limit),
      source: 'local',
    };
  }
}

export async function submitLeaderboardScore(payload: SubmitScorePayload): Promise<SubmitScoreResponse> {
  const cleanName = payload.name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 _-]/g, '')
    .slice(0, 16)
    .trim();

  if (!cleanName) {
    return { ok: false, source: 'local', error: 'Enter a callsign (1–16 letters or numbers).' };
  }

  const sanitized: SubmitScorePayload = { ...payload, name: cleanName };

  try {
    const res = await fetchWithTimeout('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitized),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      return { ok: false, source: 'server', error: json.error || `Submission failed (${res.status}).` };
    }
    return {
      ok: true,
      source: 'server',
      entry: json.entry,
      rank: json.rank,
      isTopRecord: json.isTopRecord,
      entries: json.entries,
    };
  } catch {
    // Graceful local fallback if API server is unavailable
    const local = readLocalStore();
    const entry: LeaderboardEntry = {
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...sanitized,
      score: Math.round(sanitized.score),
      createdAt: new Date().toISOString(),
    };
    const updated = sortEntries([...(local[sanitized.mode] || []), entry]).slice(0, 50);
    local[sanitized.mode] = updated;
    writeLocalStore(local);
    const rank = updated.findIndex((e) => e.id === entry.id) + 1;
    return {
      ok: true,
      source: 'local',
      entry,
      rank,
      isTopRecord: rank === 1,
      entries: updated.slice(0, 15),
    };
  }
}
