type PendingSession = { path: string; prompt: string | null };

let pending: PendingSession | null = null;

export function requestSession(path: string, prompt?: string): void {
  pending = { path, prompt: prompt ?? null };
}

export function consumeSession(): PendingSession | null {
  const p = pending;
  pending = null;
  return p;
}
