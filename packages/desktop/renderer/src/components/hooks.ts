import { useEffect, useState } from 'react';
import type { RunSnapshot } from '../../../src/ipc.js';

export interface PolledRun {
  run: RunSnapshot | undefined;
  /** True once at least one fetch for the current runId has completed. */
  settled: boolean;
}

/**
 * Polls getRun(runId) once per second while the run is still active
 * (running or waitingForHuman). Stops once it reaches a terminal state
 * but keeps returning the last snapshot.
 */
export function usePolledRun(runId: string | undefined): PolledRun {
  const [run, setRun] = useState<RunSnapshot>();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!runId) {
      setRun(undefined);
      setSettled(false);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const snapshot = await window.flowforge.getRun(runId);
        if (cancelled) return;
        setRun(snapshot);
        setSettled(true);
        if (snapshot && (snapshot.status === 'running' || snapshot.status === 'waitingForHuman')) {
          timer = window.setTimeout(poll, 1000);
        }
      } catch {
        setSettled(true);
        if (!cancelled) timer = window.setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId]);
  return { run, settled };
}
