// Path rewriting, chunking and prefix comparison in engine/ccsync.js.
const assert = require('assert');
const path = require('path');
const { normalizer, denormalizer, splitChunks, relation, forkId } = require(path.join(__dirname, '..', 'engine', 'ccsync.js'));

const winDir = 'C:\\Users\\me\\work\\app';
const macDir = '/Users/me/code/app';
const lines = [
  { type: 'user', cwd: 'c:\\Users\\me\\work\\app', message: 'hi' },
  { type: 'user', cwd: 'C:\\Users\\me\\work\\app\\backend\\src' },
  { type: 'user', cwd: 'C:\\Users\\me\\work\\appOther' },
  { type: 'x', text: 'mention "cwd":"C:\\Users\\me\\work\\app" inside a string' },
].map(o => JSON.stringify(o)).join('\n') + '\n';

// Windows -> stored form -> Mac
const stored = normalizer(winDir, true)(lines);
const onMac = denormalizer(macDir, false)(stored).trim().split('\n').map(l => JSON.parse(l));
assert.strictEqual(onMac[0].cwd, macDir, 'drive letter case does not matter');
assert.strictEqual(onMac[1].cwd, macDir + '/backend/src', 'sub-folders use the local separator');
assert.strictEqual(onMac[2].cwd, 'C:\\Users\\me\\work\\appOther', 'a sibling folder is left alone');
assert.ok(onMac[3].text.includes('C:\\Users\\me\\work\\app'), 'text inside strings is left alone');

// round trips are byte-identical, so pieces line up across machines
const macText = denormalizer(macDir, false)(stored);
assert.strictEqual(normalizer(macDir, false)(macText), stored);
const winText = denormalizer(winDir, true)(stored);
assert.strictEqual(JSON.parse(winText.split('\n')[1]).cwd, winDir + '\\backend\\src');
assert.strictEqual(normalizer(winDir, true)(winText), stored);

// a longer version shares every piece but the last
const big = Buffer.from(Array.from({ length: 6000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(400) })).join('\n') + '\n');
const cut = big.indexOf(10, 1_700_000) + 1;
const short = splitChunks(big.subarray(0, cut));
const long = splitChunks(big);
assert.ok(long.length > short.length);
assert.deepStrictEqual(short.slice(0, -1).map(c => c.sha), long.slice(0, short.length - 1).map(c => c.sha));
assert.strictEqual(relation(short, long), 'a-behind');
assert.strictEqual(relation(long, short), 'a-ahead');
assert.strictEqual(relation(long, long), 'same');
assert.strictEqual(relation([], long), 'a-behind');
const other = splitChunks(Buffer.concat([big.subarray(0, cut), Buffer.from('{"different":1}\n')]));
assert.strictEqual(relation(other, long), 'diverged');

// copies get a stable, valid session id per machine
const id = forkId('db768af8-52de-49d5-a9e8-c54552cba89c', 'mac');
assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.strictEqual(id, forkId('db768af8-52de-49d5-a9e8-c54552cba89c', 'mac'));
assert.notStrictEqual(id, forkId('db768af8-52de-49d5-a9e8-c54552cba89c', 'windows'));

console.log('unit: all checks passed');
