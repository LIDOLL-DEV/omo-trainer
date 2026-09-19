import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, validateEntry, validateState, toCsv, LIQUID_LABEL_MAX, LIQUID_SUGGESTIONS } from '../lib/model.js';
import { openDatabase } from '../server/database.mjs';
import { deviceState, connectAccount } from '../lib/sync.js';

// An optional note of what was drunk, saved beside the millilitres on a check-in.
// It is the first participant-written free text to reach the record tables and the
// CSV export, so these tests cover the sanitising and the containment as much as
// the round-trip: it must stay in the participant's own records.

const observation = (over = {}) => ({ id: 'obs', kind: 'observation', occurredAt: '2026-09-19T10:00:00+01:00',
  liquidsMl: 250, liquidsMode: 'interval', position: 'sitting', diaperNumber: 1, wettingsCount: 0, edited: false, ...over });
const legacy = (over = {}) => ({ id: 'old', occurredAt: '2026-09-19T10:00:00+01:00', liquidsMl: 900, position: 'sitting',
  diaperNumber: 1, wettingsCount: 2, probability: 50, result: 'pee', source: 'manual', edited: false, ...over });

test('a drink note is trimmed, collapsed and kept verbatim otherwise', () => {
  assert.equal(validateEntry(observation({ liquidsLabel: '  Apple   juice  ' })).liquidsLabel, 'Apple juice');
  assert.equal(validateEntry(observation({ liquidsLabel: '\u{1F964} Water' })).liquidsLabel, '\u{1F964} Water'); // emoji are ordinary text
  assert.equal(validateEntry(observation({ liquidsLabel: 'x'.repeat(LIQUID_LABEL_MAX) })).liquidsLabel.length, LIQUID_LABEL_MAX);
});

test('an absent or blank note is omitted rather than stored empty', () => {
  for (const value of [undefined, '', '   ', '\t\n', '\u202E\u200B']) {
    const entry = validateEntry(observation({ liquidsLabel: value }));
    assert.equal('liquidsLabel' in entry, false, JSON.stringify(value));
  }
});

test('control and bidi characters cannot reorder or spoof the surrounding text', () => {
  // A right-to-left override inside a table cell could otherwise disguise the
  // rest of the row, so these are stripped rather than escaped.
  assert.equal(validateEntry(observation({ liquidsLabel: 'Te\u202Ea' })).liquidsLabel, 'Te a');
  assert.equal(validateEntry(observation({ liquidsLabel: 'Juice\u0000\u001B[31m' })).liquidsLabel, 'Juice [31m');  // the escape character goes, leaving an ANSI sequence as inert text
  assert.equal(validateEntry(observation({ liquidsLabel: 'Two\u2028lines' })).liquidsLabel, 'Two lines');
});

test('a note that is too long or not text is refused', () => {
  assert.throws(() => validateEntry(observation({ liquidsLabel: 'x'.repeat(LIQUID_LABEL_MAX + 1) })), /at most 60 characters/);
  for (const value of [42, true, {}, ['Water']]) assert.throws(() => validateEntry(observation({ liquidsLabel: value })), /must be text/);
});

test('both intake record kinds round-trip the note', () => {
  // Check-ins carry interval intake; legacy cumulative snapshots stay editable,
  // so a note can be added to either.
  for (const entry of [observation({ liquidsLabel: 'Tea' }), legacy({ liquidsLabel: 'Tea' })]) {
    assert.deepEqual(validateEntry(validateEntry(entry)), validateEntry(entry));
    assert.equal(validateEntry(entry).liquidsLabel, 'Tea');
  }
  // Nothing else gains the field: a wetting, change or roll has no intake to annotate.
  const wetting = { id: 'w', kind: 'wetting', occurredAt: '2026-09-19T10:00:00+01:00', category: 'involuntary', position: 'sitting', diaperNumber: 1 };
  assert.equal('liquidsLabel' in validateEntry({ ...wetting, liquidsLabel: 'Water' }), false);
});

test('a whole backup carrying notes validates and survives a rewrite', () => {
  const state = validateState({ ...emptyState(), settings: { probability: 50, position: 'sitting' },
    entries: [observation({ liquidsLabel: 'Milk' }), observation({ id: 'obs2', liquidsLabel: 'Coffee' })] });
  assert.deepEqual(state.entries.map(entry => entry.liquidsLabel), ['Milk', 'Coffee']);
  assert.deepEqual(validateState(state), state);
});

test('the note reaches the server and comes back unchanged', () => {
  const db = openDatabase(':memory:');
  try {
    const participant = db.ensureParticipant('issuer', 'drink-note', 'Person');
    const entries = [observation({ liquidsLabel: 'Sports drink' }), observation({ id: 'obs2' })];
    const device = connectAccount(deviceState({ ...emptyState(), entries }), participant, []);
    db.sync(participant.id, device.sync.queue);
    const restored = connectAccount(deviceState(emptyState()), participant, db.records(participant.id)).entries;
    assert.deepEqual(restored, entries.map(validateEntry)); // stored whole in payload_json, so no column migration was needed
    assert.equal('liquidsLabel' in restored[1], false);
  } finally { db.close?.(); }
});

test('the CSV export gains a column without disturbing the numeric ones', () => {
  const csv = toCsv([validateEntry(observation({ liquidsLabel: 'Apple juice' }))]);
  const [header, row] = csv.split('\r\n');
  assert.equal(header.indexOf('"liquidsLabel"') > 0, true);
  const column = header.replace('﻿', '').split(',').indexOf('"liquidsLabel"');
  assert.equal(row.split(',')[column], '"Apple juice"');
  assert.equal(toCsv([validateEntry(observation())]).split('\r\n')[1].split(',')[column], '""'); // absent reads as empty
});

test('a note cannot open a spreadsheet formula, and existing columns keep their shape', () => {
  const header = toCsv([]).replace('﻿', '').split(',');
  const at = name => header.indexOf(`"${name}"`);
  for (const attack of ['=1+1', '+1', '-1', '@SUM(A1)']) {
    const row = toCsv([validateEntry(observation({ liquidsLabel: attack }))]).split('\r\n')[1].split(',');
    assert.equal(row[at('liquidsLabel')], `"'${attack}"`, attack); // neutralised with a leading apostrophe
  }
  // A quote inside the note still uses ordinary CSV doubling.
  assert.match(toCsv([validateEntry(observation({ liquidsLabel: 'Bob"s' }))]), /"Bob""s"/);
  // The guard is for text a participant wrote. Numbers and the authored enums stay
  // exactly as they were, so no existing column changes shape.
  const plain = toCsv([validateEntry(observation({ liquidsLabel: 'Water' }))]).split('\r\n')[1].split(',');
  assert.equal(plain[at('liquidsMl')], '"250"');
  assert.equal(plain[at('diaperNumber')], '"1"');
  const roll = validateEntry({ id: 'r', kind: 'roll', occurredAt: '2026-09-19T10:00:00+01:00', rolledAt: '2026-09-19T10:00:00+01:00',
    rolledResult: 'pee', result: 'pee', source: 'random', probability: 40, baseProbability: 50, probabilityModifier: 'decrease', rollRuleVersion: 2 });
  assert.equal(toCsv([roll]).split('\r\n')[1].split(',')[at('probabilityModifier')], '"decrease"');
});

test('the suggestion list is only a hint, not a restriction', () => {
  assert.ok(LIQUID_SUGGESTIONS.includes('Water'));
  assert.equal(validateEntry(observation({ liquidsLabel: 'Elderflower cordial' })).liquidsLabel, 'Elderflower cordial');
});

test('a drink note is never published to friends or their activity feed', () => {
  // Water logs already post "Liquids logged - 200 mL" to opted-in friends. The note
  // is deliberately not part of that: it is free text the participant wrote for
  // their own records, and sharing it would be a disclosure they did not ask for.
  const db = openDatabase(':memory:');
  try {
    const a = db.ensureParticipant('test', 'a', 'Alice'), b = db.ensureParticipant('test', 'b', 'Bob');
    const request = db.friends.act(a.id, { action: 'request', participantId: b.id });
    db.friends.act(b.id, { action: 'accept', id: request.id });
    db.social.saveRecordPreferences(a.id, { enabled: true, audience: 'friends', version: db.social.recordPreferences(a.id).version });
    db.sync(a.id, [{ id: 'obs', mutationId: 'm1', baseVersion: 0, entry: observation({ liquidsLabel: 'Elderflower cordial' }) }]);

    const posts = db.social.feed(b.id).items;
    assert.equal(posts.length, 1);
    assert.match(posts[0].body, /Liquids logged.*250 mL/); // the amount is still shared, as before
    assert.doesNotMatch(JSON.stringify(posts), /Elderflower|cordial|liquidsLabel/);
    assert.doesNotMatch(JSON.stringify(db.social.post(b.id, posts[0].id)), /Elderflower|cordial|liquidsLabel/);
    assert.doesNotMatch(JSON.stringify(db.activity.list(b.id).items), /Elderflower|cordial|liquidsLabel/);
    // The owner's own record still has it.
    assert.equal(db.records(a.id).find(record => record.id === 'obs').entry.liquidsLabel, 'Elderflower cordial');
  } finally { db.close?.(); }
});
