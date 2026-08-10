import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { journal } from '../src/store/journal';

// The router journals every call it routes, and the suite routes hundreds. Left pointed at
// `data/`, a single `npm test` buries a day of real traffic under fixtures — and that is the
// file `npm run replay` re-reads to try parser changes against what actually came in.
journal.useDir(mkdtempSync(join(tmpdir(), 'pumpgod-journal-')));
