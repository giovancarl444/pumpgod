import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config';

/**
 * Every parsed message is written to disk so source quality and latency can be analysed
 * after the fact. Writes are buffered and flushed on a timer — the hot path only ever
 * pushes a string onto an array, never touches the filesystem.
 */
class Journal {
  private stream?: WriteStream;
  private pending: string[] = [];
  private timer?: NodeJS.Timeout;
  private day = '';

  private rotate() {
    const today = new Date().toISOString().slice(0, 10);
    if (today === this.day && this.stream) return;
    this.stream?.end();
    this.day = today;
    const dir = resolve(ROOT, 'data');
    mkdirSync(dir, { recursive: true });
    this.stream = createWriteStream(resolve(dir, `journal-${today}.jsonl`), { flags: 'a' });
  }

  write(kind: string, payload: Record<string, unknown>) {
    this.pending.push(JSON.stringify({ t: new Date().toISOString(), kind, ...payload }));
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    this.timer = undefined;
    if (!this.pending.length) return;
    this.rotate();
    const batch = this.pending;
    this.pending = [];
    this.stream?.write(batch.join('\n') + '\n');
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.flush();
    this.stream?.end();
  }
}

export const journal = new Journal();
