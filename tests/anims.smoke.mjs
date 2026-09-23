/* Editing a character's whole set of animations, merging two of them, and
 * putting the result back into the file the game loads.
 *
 * This is the suite for the three things Luqman asked for on 2026-09-23:
 * change any animation whenever he likes, merge two into one, and one button
 * that makes the edit real in the game.
 *
 * It never writes into a game project. The file it pushes to is a copy that
 * `tests/run.sh` puts in the exports folder first, so a failed run cannot
 * leave a character in referee-for-fun with half an animation in it. What is
 * checked against the real game asset is the part that only reads: that
 * gerak works out which project it belongs to and what the button should say.
 *
 *   node tests/run-browser.mjs "http://127.0.0.1:8778/?t=..." tests/anims.smoke.mjs
 */

const lines = [];
let failed = 0;
const say = (ok, msg) => { lines.push(`${ok ? '  ok  ' : ' FAIL '}${msg}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 25000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    await wait(100);
  }
  throw new Error(`gave up waiting for ${what}`);
}

/* The sheet is the app's own panel rather than a browser dialog, so it can
 * be answered from here. Press the button whose label contains `text`. */
async function answerSheet(text) {
  await until(`the sheet asking about "${text}"`,
    () => !document.querySelector('#sheet').hidden
       && document.querySelector('#sheet-actions').children.length);
  const buttons = [...document.querySelectorAll('#sheet-actions .btn')];
  const btn = buttons.find((b) => b.textContent.includes(text));
  if (!btn) throw new Error(`no button saying "${text}" — saw: `
                            + buttons.map((b) => b.textContent).join(' | '));
  btn.click();
  await until('the sheet to close', () => document.querySelector('#sheet').hidden);
}

window.confirm = () => true;
window.prompt = () => null;

try {
  const g = await until('the app to start', () => window.gerak);
  await until('the library', () => g.state.library.length);

  const COPY = new URLSearchParams(location.search).get('copy')
    || '/Users/juslangit/Documents/gerak/exports/test-anims.glb';

  // ── a character with more than one animation in it ────────────────
  const many = g.state.library
    .filter((i) => i.anims >= 3 && i.rigged && !i.path.includes('/exports/'))
    .sort((a, b) => b.anims - a.anims)[0];
  if (!many) throw new Error('no model on this Mac has three animations in it');

  await g.openModel(many);
  await until('the model', () => g.state.bones.length);
  say(true, `opened ${many.name} — ${many.anims} animations, ${g.state.bones.length} joints`);

  // ── all of them are there, not one ────────────────────────────────
  /* Against what the loader handed over, not against the library's count:
   * that comes from a scan which can be an hour old, and a model edited
   * since would fail a test that was working perfectly. */
  const inFile = g.view.sourceClips.length;
  say(g.state.set.length === inFile, `the set holds all ${g.state.set.length} of them`);
  g.showTab('anims');
  const rows = document.querySelectorAll('#anim-list .anim-row');
  say(rows.length === inFile, `the panel lists all ${rows.length}`);
  say(g.state.set.at === 0 && !!g.state.clip,
    `the first one, "${g.state.set.current.name}", is open on the timeline`);
  say(g.state.clip.totalKeys() > 0,
    `it came in as ${g.state.clip.totalKeys()} editable keys on `
    + `${g.state.clip.tracks.size} joints`);
  say(g.state.set.entries.filter((e) => e.clip).length === 1,
    'and the other animations have not been read out of the file yet');

  // ── edit one, switch away, come back ──────────────────────────────
  const first = g.state.set.current.name;
  const joint = g.state.bones.find((b) => /hand|arm|head|spine/i.test(b.name)) || g.state.bones[1];
  g.setFrame(6);
  joint.rotation.z += 0.4;
  g.keyPose(6);
  const edited = g.state.clip.totalKeys();
  say(g.state.set.current.dirty, `edited "${first}" — it is marked with a dot`);

  const second = g.state.set.entries[2].name;
  g.openAnim(2);
  await wait(120);
  say(g.state.clip.name === second, `switched to "${second}" with one click`);
  say(g.state.set.entries[0].dirty, `and "${first}" kept its dot while away`);

  g.openAnim(0);
  await wait(120);
  say(g.state.clip.totalKeys() === edited,
    `back on "${first}", all ${edited} keys are still there`);
  say(g.state.clip.hasKey(joint.name, 6), 'including the one that was just set');

  say(document.querySelectorAll('#anim-list .anim-row.is-open').length === 1,
    'exactly one row is marked as the open one');

  // ── which game it belongs to ──────────────────────────────────────
  const where = g.state.game && g.state.game.here;
  if (where) {
    say(true, `gerak worked out this character lives in ${where.game}`);
    say(document.querySelector('#btn-push').textContent.includes(where.game),
      `the button says "${document.querySelector('#btn-push').textContent}"`);
    say(!document.querySelector('#btn-push').disabled,
      'and it is live, because something has been edited');
  } else {
    say(true, 'this character is not in a game project, so the button will ask which one');
  }

  // ── merging two of them ───────────────────────────────────────────
  const names = g.state.set.names();
  const [keepName, dropName] = [names[1], names[2]];
  const ticks = [...document.querySelectorAll('.anim-pick')];
  ticks[1].checked = true; ticks[1].dispatchEvent(new Event('change'));
  say(document.querySelector('#btn-merge').disabled, 'one ticked is not enough to merge');
  ticks[2].checked = true; ticks[2].dispatchEvent(new Event('change'));
  say(!document.querySelector('#btn-merge').disabled, 'two ticked and the Merge button wakes up');

  const merging = g.mergeAnims();
  await answerSheet(`Keep "${keepName}"`);
  await merging;

  say(g.state.set.length === inFile - 1,
    `${inFile} animations became ${g.state.set.length}`);
  say(!g.state.set.names().includes(dropName), `"${dropName}" is gone from the list`);
  say(g.state.set.names().includes(keepName), `"${keepName}" is the one that stayed`);
  say(g.state.set.removed.includes(dropName),
    'and the file is due to lose it the next time the game is updated');

  // ── and undo puts it back ─────────────────────────────────────────
  g.undo();
  await wait(120);
  say(g.state.set.length === inFile, `undo brought it back to ${g.state.set.length}`);
  say(g.state.set.names().includes(dropName), `"${dropName}" is in the list again`);
  say(g.state.set.removed.length === 0, 'and nothing is queued for deletion');
  g.redo();
  await wait(120);
  say(!g.state.set.names().includes(dropName), 'redo takes it away again');

  // ── the push, into a copy rather than the game ────────────────────
  const copy = g.state.library.find((i) => i.path === COPY)
    || await g.api(`/api/describe?t=${encodeURIComponent(window.GERAK_TOKEN)}`
                   + `&path=${encodeURIComponent(COPY)}`).catch(() => null);
  if (!copy || !copy.path) {
    say(true, 'no test copy in exports/, so the push itself was not run '
              + '(tests/run.sh makes one)');
  } else {
    await g.openModel(copy);
    await until('the copy', () => g.state.bones.length);
    const before = g.state.set.names();
    say(before.length >= 3, `opened the copy — ${before.length} animations`);

    // Edit the first, merge the last two, then push the lot.
    g.openAnim(0);
    const bone = g.state.bones.find((b) => /hand|arm|head|spine/i.test(b.name)) || g.state.bones[1];
    g.setFrame(4);
    bone.rotation.x += 0.35;
    g.keyPose(4);
    const target = { name: before[0], joint: bone.name };

    const gone = before[before.length - 1];
    const doomed = g.state.set.merge(before.length - 2, before.length - 1,
      (s) => window.gerak.state.clip.constructor.fromAnimationClip(
        s, g.state.bones, g.view.restPose, 24));
    say(!!doomed, `merged "${doomed.dropped}" away, keeping "${doomed.kept}"`);

    const { clips, remove } = g.state.set.push();
    const result = await g.api('/api/push', {
      model: copy.path, clips, remove, game: '',
    });
    say(result.ok, `the file was written: ${result.shown}`);
    say(result.replaced.includes(target.name),
      `"${target.name}" was replaced in the file`);
    say(result.removed.includes(gone), `"${gone}" was deleted from the file`);
    say(!!result.backup, `a backup went to ${result.shownBackup}`);
    const touched = result.replaced.length + result.removed.length;
    say(result.left_alone.length === before.length - touched,
      `${result.left_alone.length} animations nobody edited were left alone, `
      + `and the other ${touched} were rewritten or deleted`);
    say(!result.left_alone.some((n) => result.replaced.includes(n)),
      'nothing is counted as both left alone and rewritten');
    say(result.keys_after <= result.keys_before,
      `keys thinned from ${result.keys_before} to ${result.keys_after}`);

    // ── and the proof: open the file again and look ─────────────────
    g.state.set = new (g.state.set.constructor)();   // so it does not ask
    await g.openModel(copy);
    await until('the file again', () => g.state.bones.length);
    const now = g.state.set.names();
    say(!now.includes(gone), `reopened: "${gone}" really is not in the file any more`);
    say(now.length === before.length - 1, `${now.length} animations in the file now`);

    g.openAnim(now.indexOf(target.name));
    await wait(150);
    say(g.state.clip.tracks.has(target.joint),
      `the edited animation came back with a track on ${target.joint}`);
    say(g.state.clip.totalKeys() > 0,
      `and ${g.state.clip.totalKeys()} keys, read back out of the game's own file`);
  }
} catch (err) {
  say(false, `threw: ${err && err.message}`);
}

return { failed, text: lines.join('\n') };
