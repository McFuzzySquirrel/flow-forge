import type { ReactNode } from 'react';

/** Strip the Electron "Error invoking remote method '...': Error:" wrapper. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '');
  }
  return String(err);
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="ff-tag">{children}</span>;
}

export function Loading() {
  return <p className="ff-muted">Loading…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="ff-muted">{children}</p>;
}

export function ErrorInline({ error }: { error: string | undefined }) {
  if (!error) return null;
  return <div className="ff-error-card">{error}</div>;
}

export function shortId(id: string, len = 10): string {
  return id.length <= len ? id : `${id.slice(0, len)}…`;
}
