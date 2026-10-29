import type { ConvertSettings, JobResponse } from './types';

interface Task {
  id: number;
  file: File;
  settings: ConvertSettings;
  resolve: (r: JobResponse) => void;
}

/** A fixed-size pool of conversion workers; each processes one image at a time. */
export class WorkerPool {
  readonly size: number;
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Task[] = [];
  private running = new Map<Worker, Task>();
  private nextId = 1;

  constructor(size = defaultPoolSize()) {
    this.size = size;
  }

  run(file: File, settings: ConvertSettings): Promise<JobResponse> {
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, file, settings, resolve });
      this.pump();
    });
  }

  /** Drop queued work and terminate busy workers (WASM encodes can't be interrupted otherwise). */
  cancel() {
    for (const t of this.queue) t.resolve({ id: t.id, ok: false, error: 'Cancelled' });
    this.queue = [];
    for (const [w, t] of this.running) {
      w.terminate();
      this.workers.splice(this.workers.indexOf(w), 1);
      t.resolve({ id: t.id, ok: false, error: 'Cancelled' });
    }
    this.running.clear();
  }

  get active() {
    return this.running.size;
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<JobResponse>) => this.finish(w, e.data);
    w.onerror = (e) => {
      e.preventDefault();
      this.finish(w, { id: this.running.get(w)?.id ?? 0, ok: false, error: e.message || 'Worker crashed' });
    };
    this.workers.push(w);
    return w;
  }

  private finish(w: Worker, res: JobResponse) {
    const task = this.running.get(w);
    this.running.delete(w);
    this.idle.push(w);
    task?.resolve(res);
    this.pump();
  }

  private pump() {
    while (this.queue.length) {
      const w = this.idle.pop() ?? (this.workers.length < this.size ? this.spawn() : undefined);
      if (!w) return;
      const task = this.queue.shift()!;
      this.running.set(w, task);
      w.postMessage({ id: task.id, file: task.file, settings: task.settings });
    }
  }
}

function defaultPoolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  // Leave one core for the UI thread; cap to keep memory sane with large AVIF encodes.
  return Math.max(1, Math.min(cores - 1, 12));
}
