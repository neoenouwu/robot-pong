import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const VALID_MODES = new Set(['arcade', 'duel']);
export const MAX_ENTRIES_PER_MODE = 100;

export const SEED_DATA = {
  version: 1,
  entries: {
    arcade: [
      {
        id: 'seed-arc-1',
        name: 'NEO_01',
        mode: 'arcade',
        score: 18450,
        bestRally: 29,
        maxPhase: 4,
        perfectHits: 14,
        difficulty: 'overdrive',
        createdAt: '2026-11-18T08:15:00.000Z',
      },
      {
        id: 'seed-arc-2',
        name: 'TRINITY',
        mode: 'arcade',
        score: 14200,
        bestRally: 23,
        maxPhase: 4,
        perfectHits: 11,
        difficulty: 'overdrive',
        createdAt: '2026-11-19T14:40:00.000Z',
      },
      {
        id: 'seed-arc-3',
        name: 'MORPHEUS',
        mode: 'arcade',
        score: 10850,
        bestRally: 19,
        maxPhase: 3,
        perfectHits: 8,
        difficulty: 'overdrive',
        createdAt: '2026-11-20T03:22:00.000Z',
      },
      {
        id: 'seed-arc-4',
        name: 'NIOBE',
        mode: 'arcade',
        score: 7600,
        bestRally: 15,
        maxPhase: 3,
        perfectHits: 6,
        difficulty: 'overdrive',
        createdAt: '2026-11-20T19:05:00.000Z',
      },
      {
        id: 'seed-arc-5',
        name: 'TANK',
        mode: 'arcade',
        score: 4950,
        bestRally: 11,
        maxPhase: 2,
        perfectHits: 4,
        difficulty: 'overdrive',
        createdAt: '2026-11-21T11:30:00.000Z',
      },
      {
        id: 'seed-arc-6',
        name: 'CYPHER',
        mode: 'arcade',
        score: 2600,
        bestRally: 7,
        maxPhase: 1,
        perfectHits: 2,
        difficulty: 'overdrive',
        createdAt: '2026-11-21T22:10:00.000Z',
      },
    ],
    duel: [
      {
        id: 'seed-duel-1',
        name: 'THE_ONE',
        mode: 'duel',
        score: 9850,
        bestRally: 22,
        maxPhase: 4,
        perfectHits: 12,
        difficulty: 'architect',
        matchScore: '11-3',
        createdAt: '2026-11-18T12:00:00.000Z',
      },
      {
        id: 'seed-duel-2',
        name: 'SERAPH',
        mode: 'duel',
        score: 7900,
        bestRally: 18,
        maxPhase: 3,
        perfectHits: 9,
        difficulty: 'architect',
        matchScore: '11-6',
        createdAt: '2026-11-19T16:30:00.000Z',
      },
      {
        id: 'seed-duel-3',
        name: 'GHOST',
        mode: 'duel',
        score: 5400,
        bestRally: 14,
        maxPhase: 2,
        perfectHits: 6,
        difficulty: 'hunter',
        matchScore: '11-7',
        createdAt: '2026-11-20T09:45:00.000Z',
      },
      {
        id: 'seed-duel-4',
        name: 'LINK',
        mode: 'duel',
        score: 3650,
        bestRally: 10,
        maxPhase: 2,
        perfectHits: 4,
        difficulty: 'scout',
        matchScore: '11-8',
        createdAt: '2026-11-21T17:12:00.000Z',
      },
    ],
  },
};

export function sanitizeCallsign(raw) {
  if (typeof raw !== 'string') return '';
  // Strip control characters and HTML-unsafe symbols, allow A-Z 0-9 _ - space
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 16)
    .trim();
  return cleaned;
}

export function validateEntryPayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Payload must be a JSON object.' };
  }

  const name = sanitizeCallsign(body.name);
  if (name.length < 1) {
    return { ok: false, error: 'Callsign must contain 1–16 alphanumeric characters.' };
  }

  const mode = typeof body.mode === 'string' ? body.mode.toLowerCase() : '';
  if (!VALID_MODES.has(mode)) {
    return { ok: false, error: 'Mode must be "arcade" or "duel".' };
  }

  const score = Number(body.score);
  if (!Number.isFinite(score) || score < 0 || score > 5_000_000) {
    return { ok: false, error: 'Score must be a finite number between 0 and 5,000,000.' };
  }

  const bestRally = Number(body.bestRally ?? 0);
  if (!Number.isFinite(bestRally) || bestRally < 0 || bestRally > 5000) {
    return { ok: false, error: 'Invalid bestRally value.' };
  }

  const maxPhase = Number(body.maxPhase ?? 1);
  if (!Number.isFinite(maxPhase) || maxPhase < 1 || maxPhase > 10) {
    return { ok: false, error: 'Invalid maxPhase value.' };
  }

  const perfectHits = Number(body.perfectHits ?? 0);
  if (!Number.isFinite(perfectHits) || perfectHits < 0 || perfectHits > 5000) {
    return { ok: false, error: 'Invalid perfectHits value.' };
  }

  const allowedDiff = new Set(['overdrive', 'scout', 'hunter', 'architect']);
  const difficulty =
    typeof body.difficulty === 'string' && allowedDiff.has(body.difficulty.toLowerCase())
      ? body.difficulty.toLowerCase()
      : mode === 'arcade'
        ? 'overdrive'
        : 'hunter';

  let matchScore = undefined;
  if (typeof body.matchScore === 'string') {
    const m = body.matchScore.trim().match(/^(\d{1,2})-(\d{1,2})$/);
    if (m) matchScore = `${m[1]}-${m[2]}`;
  }

  return {
    ok: true,
    entry: {
      id: crypto.randomUUID(),
      name,
      mode,
      score: Math.round(score),
      bestRally: Math.round(bestRally),
      maxPhase: Math.round(maxPhase),
      perfectHits: Math.round(perfectHits),
      difficulty,
      ...(matchScore ? { matchScore } : {}),
      createdAt: new Date().toISOString(),
    },
  };
}

function sortEntries(list) {
  return [...list].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.bestRally !== a.bestRally) return b.bestRally - a.bestRally;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

function cloneSeed() {
  return JSON.parse(JSON.stringify(SEED_DATA));
}

export class LeaderboardStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._queue = Promise.resolve();
    this._recoveredFromCorruption = false;
  }

  _enqueue(task) {
    const next = this._queue.then(task, task);
    this._queue = next.catch(() => {});
    return next;
  }

  async _readRaw() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !parsed.entries ||
        !Array.isArray(parsed.entries.arcade) ||
        !Array.isArray(parsed.entries.duel)
      ) {
        throw new Error('Malformed leaderboard schema');
      }
      return parsed;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const seeded = cloneSeed();
        await this._writeAtomic(seeded);
        return seeded;
      }
      // Corrupted JSON: back up the broken file so data isn't silently lost, then re-seed
      this._recoveredFromCorruption = true;
      try {
        const backupPath = `${this.filePath}.corrupt-${Date.now()}.bak`;
        await fs.rename(this.filePath, backupPath);
      } catch {
        // Ignore if file disappeared
      }
      const seeded = cloneSeed();
      await this._writeAtomic(seeded);
      return seeded;
    }
  }

  async _writeAtomic(data) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, payload, 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }

  async list(mode = 'arcade', limit = 20) {
    const safeMode = VALID_MODES.has(mode) ? mode : 'arcade';
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return this._enqueue(async () => {
      const data = await this._readRaw();
      const sorted = sortEntries(data.entries[safeMode] || []);
      return {
        mode: safeMode,
        total: sorted.length,
        entries: sorted.slice(0, safeLimit),
        recovered: this._recoveredFromCorruption,
      };
    });
  }

  async submit(payload) {
    const validation = validateEntryPayload(payload);
    if (!validation.ok) {
      return { ok: false, status: 400, error: validation.error };
    }

    const entry = validation.entry;
    return this._enqueue(async () => {
      const data = await this._readRaw();
      const existing = data.entries[entry.mode] || [];
      const updated = sortEntries([...existing, entry]).slice(0, MAX_ENTRIES_PER_MODE);
      data.entries[entry.mode] = updated;
      await this._writeAtomic(data);

      const rankIndex = updated.findIndex((e) => e.id === entry.id);
      const rank = rankIndex >= 0 ? rankIndex + 1 : null;
      return {
        ok: true,
        status: 201,
        entry,
        rank,
        isTopRecord: rank === 1,
        entries: updated.slice(0, 20),
      };
    });
  }
}
