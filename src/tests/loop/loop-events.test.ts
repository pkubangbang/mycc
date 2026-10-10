import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopEvents } from '../../loop/loop-events.js';

afterEach(() => {
  loopEvents.clear();
});

describe('LoopEventEmitter trace retention', () => {
  it('notifies listeners without retaining an unbounded trace by default', () => {
    const listener = vi.fn();
    loopEvents.on('state_transition', listener);

    loopEvents.emit('state_transition', { from: 'llm', to: 'hook' });
    loopEvents.emit('state_transition', { from: 'hook', to: 'tool' });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(loopEvents.getTrace()).toEqual([]);
  });

  it('retains events only when tracing is explicitly enabled', () => {
    const listener = vi.fn();
    loopEvents.on('state_transition', listener);
    loopEvents.setTraceEnabled(true);

    loopEvents.emit('state_transition', { from: 'llm', to: 'hook' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(loopEvents.getTrace()).toHaveLength(1);
    expect(loopEvents.getTrace()[0].event).toBe('state_transition');
  });
});
