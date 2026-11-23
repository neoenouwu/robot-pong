export const VALID_MODES: Set<string>;
export function sanitizeCallsign(raw: unknown): string;
export function validateEntryPayload(body: unknown): {
  ok: boolean;
  error?: string;
  entry?: Record<string, unknown>;
};
export class LeaderboardStore {
  constructor(filePath: string);
  list(mode?: string, limit?: number): Promise<{
    mode: string;
    total: number;
    entries: Array<Record<string, unknown>>;
    recovered: boolean;
  }>;
  submit(payload: Record<string, unknown>): Promise<{
    ok: boolean;
    status: number;
    error?: string;
    entry?: Record<string, unknown>;
    rank?: number | null;
    isTopRecord?: boolean;
    entries?: Array<Record<string, unknown>>;
  }>;
}
