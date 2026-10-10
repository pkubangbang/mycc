import { describe, expect, it } from 'vitest';
import { parsePatchResponse } from '../../loop/checkpoint-recap.js';
import type { Mindmap } from '../../mindmap/types.js';

const mindmap: Mindmap = {
  dir: '.',
  source_file: 'MYCC.md',
  hash: 'test-hash',
  compiled_at: '',
  updated_at: '',
  root: {
    id: '/',
    title: 'root',
    text: 'root node',
    summary: '',
    level: 0,
    children: [],
    links: [],
  },
};

describe('checkpoint recap patch root guard', () => {
  it.each(['update', 'delete'] as const)('rejects %s against root aliases', (action) => {
    const fields = action === 'update' ? ',"text":"overwritten root"' : '';
    const response = `{"action":"${action}","path":"///"${fields}}`;

    const result = parsePatchResponse(response, mindmap, 'checkpoint-1');

    expect(result.patch).toBeNull();
    expect(result.error).toContain('Cannot update or delete root node');
  });
});
