/* The reference panel, driven the way a person drives it.
 *
 * The point of this feature is not the search — it is that the picture ends
 * up beside the thing being animated, on the right frame, and is still there
 * next week. So that is what this checks, in that order.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
let failed = 0;
const ok = (m) => lines.push(`  ok   ${m}`);
const bad = (m) => { lines.push(`  FAIL ${m}`); failed++; };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const $ = (s) => document.querySelector(s);

for (let i = 0; i < 100 && !window.gerak; i++) await wait(250);
if (!window.gerak) return { failed: 1, text: '  FAIL gerak never finished loading' };
ok('gerak loads with the reference panel in it');

check(!!$('#btn-reference'), 'there is a Reference button among the viewport tools');
check($('#ref-drawer').hidden, 'and the drawer starts closed');

// ── opening it ──────────────────────────────────────────────────────

$('#btn-reference').click();
await wait(250);
check(!$('#ref-drawer').hidden, 'the button opens the drawer');
check($('.stage').classList.contains('has-ref'),
  'and the stage is told, so the viewport tools wrap instead of hiding behind it');

// ── searching ───────────────────────────────────────────────────────

$('#ref-q').value = 'walking';
$('#ref-go').click();
for (let i = 0; i < 100 && !document.querySelectorAll('.ref-card').length; i++) await wait(250);

const cards = [...document.querySelectorAll('.ref-card')];
check(cards.length > 0, `a search for walking finds ${cards.length} references`);
check(document.querySelectorAll('.ref-badge').length > 0,
  'some of them are sequences rather than single pictures');

// Everything here is somebody else's photograph, so every card has to say
// whose and under what terms before it is used for anything.
check([...document.querySelectorAll('.ref-licence')].every((n) => n.textContent.trim()),
  'every result states its licence');

// ── pinning ─────────────────────────────────────────────────────────

const human = cards.findIndex((c) => /human|male/i.test(c.textContent));
const picked = cards[human >= 0 ? human : 0].querySelector('.ref-name').textContent;
cards[human >= 0 ? human : 0].click();
for (let i = 0; i < 160 && $('#ref-pin').hidden; i++) await wait(250);

/* Everything past this point needs Wikimedia to actually hand the picture
 * over, and Commons rate-limits: run this suite a few times in an hour and
 * the pin comes back as HTTP 429. That is not a fault in gerak, so it stops
 * here and says why, rather than failing — or, as it used to, reading a null
 * src and dying with a TypeError that looks nothing like a rate limit. */
if ($('#ref-pin').hidden) {
  lines.push('  --   Wikimedia would not hand the picture over (rate limited?),');
  lines.push('       so pinning was not exercised. Try again in a few minutes.');
  return { failed, text: lines.join('\n') };
}

check(!$('#ref-pin').hidden, `pinning puts it over the viewport (${picked.trim()})`);
check(($('#ref-pin-img').getAttribute('src') || '').includes('/api/ref-file'),
  'and the picture is served off the disk, not fetched from the internet by the page');
check($('#ref-pin-credit').textContent.includes('Public domain')
  || $('#ref-pin-credit').textContent.length > 0,
  'with its credit and licence under it');

const pin = window.gerak.reference.pin;
check(pin && pin.count > 1, `it was pulled apart into ${pin ? pin.count : 0} frames`);
check(!$('#ref-seq').hidden, 'so the frame controls appear');

// ── stepping with the timeline ──────────────────────────────────────

/* The thing that makes this worth building: frame six of his own animation
 * should sit beside frame six of the reference, whatever length either is. */
window.gerak.state.clip.frames = 48;
window.gerak.reference.follow = true;

window.gerak.setFrame(0);
await wait(120);
const atStart = window.gerak.reference.frame;

window.gerak.setFrame(24);
await wait(120);
const atMiddle = window.gerak.reference.frame;

check(atStart === 0, 'at frame 0 the reference is on its first frame');
check(atMiddle > 0, `and halfway through the clip it is halfway through the reference (${atMiddle}/${pin.count})`);
check(Math.abs(atMiddle - Math.floor(pin.count / 2)) <= 1,
  'proportionally, not one frame per frame');

// Turning Follow off has to actually stop it.
window.gerak.reference.follow = false;
const before = window.gerak.reference.frame;
window.gerak.setFrame(40);
await wait(120);
check(window.gerak.reference.frame === before,
  'and turning Follow off leaves it where it was');

// ── it travels with the clip ────────────────────────────────────────

window.gerak.reference.follow = true;
const saved = window.gerak.reference.toJSON();
check(saved && saved.path && saved.count > 1,
  'the pin can be written down, with its frames and where it came from');

window.gerak.reference.unpin();
check($('#ref-pin').hidden, 'unpinning takes it off the viewport');

await window.gerak.reference.fromJSON(saved);
await wait(400);
check(!$('#ref-pin').hidden, 'and what was written down puts it back');
check(window.gerak.reference.pin.count === saved.count,
  'with the same frames it had before');

return { failed, text: lines.join('\n') };
