import { describe, expect, it } from 'vitest';
import { additions, parseChoices, watchable, type Destination, type WatchedSource } from '../scripts/setup';

/**
 * Setup writes the file that decides who we read and how they are scored. Every case here is
 * one where getting it wrong is invisible at the time and expensive later: a table that ranks
 * us against ourselves, a group silently listed twice, or an id that moves between weeks and
 * takes a group's whole history with it.
 */

function room(title: string, extra: Partial<Destination> = {}): Destination {
  return { title, id: `-100${title.length}`, broadcast: false, admin: false, ...extra };
}

describe('which rooms are offered', () => {
  it('never offers the channel we publish to', () => {
    // Watching our own channel feeds published calls back in as somebody else's, against a
    // table whose entire job is comparing us to them.
    const rows = [room('pumpgod', { username: 'pumpgod', broadcast: true }), room('Rival Group')];
    expect(watchable(rows, ['@pumpgod', undefined]).map((r) => r.title)).toEqual(['Rival Group']);
  });

  it('never offers the war room either', () => {
    const rows = [room('War Room', { id: '-1009999' }), room('Rival Group')];
    expect(watchable(rows, [undefined, '-1009999']).map((r) => r.title)).toEqual(['Rival Group']);
  });

  it('matches our own rooms however they were written down', () => {
    // `.env` may carry `@name`, `name` or a raw id depending on whether it was picked here or
    // typed by hand, and all three name the same chat.
    const rows = [room('pumpgod', { username: 'PumpGod', broadcast: true })];
    expect(watchable(rows, ['pumpgod'])).toHaveLength(0);
    expect(watchable(rows, ['@PUMPGOD'])).toHaveLength(0);
  });
});

describe('what gets added to the watch list', () => {
  it('starts every group in shadow mode', () => {
    // Nothing is ever published from a new source. Promotion is a decision, not a default.
    const added = additions([room('Rival Group', { username: 'rivals' })], []);
    expect(added).toEqual([
      { id: 'rivals', label: 'Rival Group', username: 'rivals', mode: 'shadow', enabled: true },
    ]);
  });

  it('falls back to the peer id for a private group with no username', () => {
    const added = additions([room('Private Alpha')], []);
    expect(added[0]).toMatchObject({ id: 'private-alpha', peerId: '-10013' });
    expect(added[0]!.username).toBeUndefined();
  });

  it('skips a group that is already listed, so re-running setup cannot duplicate it', () => {
    const existing: WatchedSource[] = [
      { id: 'rivals', label: 'Rival Group', username: 'rivals', mode: 'review', enabled: true },
    ];
    const added = additions([room('Rival Group', { username: 'rivals' }), room('New Group')], existing);
    expect(added.map((s) => s.label)).toEqual(['New Group']);
  });

  // A source's id is what the ratings table keys a group's anonymous label off. Two groups
  // sharing one would merge their records into a single row of somebody else's calls.
  it('does not hand two groups the same id', () => {
    const added = additions([room('Alpha Calls'), room('alpha calls!')], []);
    expect(added.map((s) => s.id)).toEqual(['alpha-calls', 'alpha-calls-2']);
  });

  it('does not collide with an id already in the file', () => {
    const existing: WatchedSource[] = [
      { id: 'alpha-calls', label: 'Alpha Calls', peerId: '-1001', mode: 'shadow', enabled: true },
    ];
    expect(additions([room('Alpha Calls', { id: '-1002' })], existing)[0]!.id).toBe('alpha-calls-2');
  });
});

describe('reading the numbers back', () => {
  it('takes a comma-separated list as zero-based picks', () => {
    expect(parseChoices('1,2,3', 5)).toEqual([0, 1, 2]);
  });

  it('tolerates spaces and repeats', () => {
    expect(parseChoices('1, 3  3', 5)).toEqual([0, 2]);
  });

  it('ignores anything that is not one of the numbers shown', () => {
    expect(parseChoices('2, 99, banana, -1', 3)).toEqual([1]);
  });
});
