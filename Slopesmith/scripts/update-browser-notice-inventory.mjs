import { build } from 'vite';

// This is intentionally an explicit maintenance command: changing the checked package inventory should be a
// reviewed source diff, while an ordinary build must fail closed when the browser graph changes.
process.env.SLOPESMITH_WRITE_NOTICE_INVENTORY = '1';
await build({ build: { write: false } });
