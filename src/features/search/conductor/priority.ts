import { spawnSync } from 'node:child_process';
import { setPriority } from 'node:os';

/**
 * The pipeline worker's OS floor (SPEC.md §5.2.5; DECISIONS.md, 2026-09-01).
 *
 * Two things, and the ruling is explicit that they are not equal. **Minimum CPU priority is
 * the strong guarantee**, taken through the runtime's own cross-platform call, which is
 * POSIX nice where that is what the platform has and the equivalent class where it is not.
 * **A background I/O class is opportunistic**: idle I/O on Linux, the background policy on
 * macOS, background mode on Windows, best effort elsewhere. Nothing in the design leans on
 * the second — the platform-neutral dampers, one fsync per micro-batch and the fetch
 * back-off, do not depend on it — so failing to get it is reported and never fatal.
 *
 * Node exposes the first and none of the rest. `os.setPriority` is real everywhere; there
 * is no binding for `ioprio_set`, `setiopolicy_np` or `PROCESS_MODE_BACKGROUND_BEGIN`, so
 * the I/O class is asked for through `ionice` where that exists and reported as unavailable
 * where it does not. Shelling out for it is worth it exactly once, at startup, and worth
 * nothing at all if it fails — which is why the failure path is a field in a report rather
 * than an exception.
 *
 * Everything is injected so this can be tested without a test that renices the runner.
 */

export const WORKER_NICE = 19;

export interface PriorityOutcome {
  applied: boolean;
  detail?: string;
}

export interface PriorityReport {
  cpu: PriorityOutcome;
  io: PriorityOutcome;
}

export interface LowerPriorityOptions {
  platform?: NodeJS.Platform;
  nice?: number;
  setPriority?: (pid: number, priority: number) => void;
  run?: (command: string, args: string[]) => { status: number | null; error?: Error };
  pid?: number;
}

/** Put this process on the floor. Call once, at worker startup, before any work. */
export function lowerWorkerPriority(opts: LowerPriorityOptions = {}): PriorityReport {
  const platform = opts.platform ?? process.platform;
  const nice = opts.nice ?? WORKER_NICE;
  const pid = opts.pid ?? process.pid;
  const applyCpu = opts.setPriority ?? ((p: number, value: number): void => setPriority(p, value));
  const run =
    opts.run ??
    ((command: string, args: string[]): { status: number | null; error?: Error } => {
      const res = spawnSync(command, args, { stdio: 'ignore' });
      return { status: res.status, error: res.error };
    });

  return { cpu: applyCpuFloor(applyCpu, pid, nice), io: applyIoClass(run, platform, pid) };
}

function applyCpuFloor(
  applyCpu: (pid: number, priority: number) => void,
  pid: number,
  nice: number,
): PriorityOutcome {
  try {
    applyCpu(pid, nice);
    return { applied: true, detail: `nice ${nice}` };
  } catch (e) {
    // A container can forbid it, and a worker that refused to start over its own politeness
    // would trade the whole pipeline for a scheduling hint.
    return { applied: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function applyIoClass(
  run: (command: string, args: string[]) => { status: number | null; error?: Error },
  platform: NodeJS.Platform,
  pid: number,
): PriorityOutcome {
  if (platform !== 'linux') {
    // Named rather than silently skipped: "best effort elsewhere" is the ruling's own
    // wording, and an outcome that says which platform declined is what makes the
    // instrument panel's claim about I/O class honest on a Mac.
    return { applied: false, detail: `no I/O class binding on ${platform}` };
  }
  const res = run('ionice', ['-c', '3', '-p', String(pid)]);
  if (res.error || res.status !== 0) {
    return { applied: false, detail: res.error ? res.error.message : `ionice exited ${res.status}` };
  }
  return { applied: true, detail: 'idle I/O' };
}
