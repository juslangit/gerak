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

const state_usage = () => window.gerak.state.usage && window.gerak.state.usage.counts;

try {
  const g = await until('the app to start', () => window.gerak);
  await until('the library', () => g.state.library.length);

  const COPY = new URLSearchParams(location.search).get('copy')
    || '/Users/juslangit/Documents/gerak/exports/test-anims.glb';

  // ── a character with more than one animation in it ────────────────
  const many = g.state.library
    .filter((i) => i.anims >= 3 && i.rigged
      && !i.path.includes('/exports/') && !i.path.includes('/backups/'))
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
  /* Lazily, except for any saved edits put back from the clips folder —
   * those had to be read to be put back, and are marked as work the game's
   * file does not have yet. */
  const lazy = g.state.set.entries.filter((e, i) => i !== g.state.set.at && !e.dirty);
  say(lazy.length > 0 && lazy.every((e) => !e.clip),
    `the ${lazy.length} animations that are neither open nor restored have not `
    + 'been read out of the file yet');

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

  // ── the three bugs of 2026-09-23 ──────────────────────────────────
  //
  // He edited a few keyframes, pressed Save, pressed Update the game — and
  // nothing was written. Then reopening the character showed the original.

  // (a) merely switching animations must not count as an edit
  {
    const before = g.state.set.entries.filter((e) => e.dirty).length;
    g.openAnim(4); await wait(150);
    g.openAnim(5); await wait(150);
    g.openAnim(0); await wait(150);
    const after = g.state.set.entries.filter((e) => e.dirty).length;
    say(after === before,
      `clicking through animations marked ${after - before} of them as edited`);
    say(g.state.set.unsavedEntries().every((e) => e.name === first),
      'and only the one actually edited is waiting to be saved');
  }

  // (c) shortening a clip must shorten what the game gets
  {
    g.openAnim(0); await wait(150);
    const full = g.state.clip.frames;
    const keys = g.state.clip.totalKeys();
    const half = Math.max(2, Math.floor(full / 2));

    const field = document.querySelector('#length-field');
    field.value = String(half);
    field.dispatchEvent(new Event('input'));
    await wait(120);

    say(g.state.clip.frames === half, `limited the clip from ${full} to ${half} frames`);
    say(g.state.clip.totalKeys() === keys,
      'the keys past the end are kept, not deleted');
    const past = g.state.clip.keysPastEnd();
    say(past > 0, `${past} keys now sit after the end`);

    const tag = document.querySelector('#anim-list .anim-row.is-open .tag-trim');
    say(!!tag && tag.textContent.includes(String(past)),
      'and the panel says so on the row');

    // What would actually be written:
    const out = g.state.clip.exportKeys([...g.state.clip.tracks.keys()][0]);
    say(out[out.length - 1].f === half,
      `what leaves gerak ends at ${out[out.length - 1].f}, not ${full}`);
    say(out.every((k) => k.f <= half), 'and carries nothing past the end');

    const made = g.state.clip.toAnimationClip(g.state.bones);
    say(Math.abs(made.duration - half / g.state.clip.fps) < 1e-6,
      'the exported animation is as long as the timeline says');
    say(made.tracks.every((t) => t.times[t.times.length - 1] <= half / g.state.clip.fps + 1e-6),
      'and not one of its tracks runs past the end');

    field.value = String(full);
    field.dispatchEvent(new Event('input'));
    await wait(120);
    say(g.state.clip.keysPastEnd() === 0, 'lengthening it again brings them back');
  }

  // ── used or unused, beside the keys ───────────────────────────────
  if (where) {
    await until('the usage tags', () => state_usage());
    const counts = g.state.usage.counts;
    const used = Object.values(counts).filter(Boolean).length;
    say(Object.keys(counts).length === inFile,
      `the game was asked about all ${Object.keys(counts).length} animations`);
    say(true, `${used} are named in ${where.game}, ${inFile - used} are not`);

    const tags = [...document.querySelectorAll('#anim-list .tag-used, #anim-list .tag-unused')];
    say(tags.length === inFile, `every row carries a used-or-unused tag (${tags.length})`);

    // The tag must agree with the count for that row, not just exist.
    const rows = [...document.querySelectorAll('#anim-list .anim-row')];
    const wrong = rows.filter((row, i) => {
      const name = g.state.set.entries[i].from;
      const tag = row.querySelector('.tag-used, .tag-unused');
      if (!tag) return true;
      return tag.classList.contains('tag-used') !== !!counts[name];
    });
    say(wrong.length === 0, 'and each tag says what the search actually found');

    const someUsed = Object.entries(counts).find(([, n]) => n > 1);
    if (someUsed) {
      const at = g.state.set.entries.findIndex((e) => e.from === someUsed[0]);
      const tag = rows[at].querySelector('.tag-used');
      say(tag && tag.textContent.includes(String(someUsed[1])),
        `"${someUsed[0]}" shows its ${someUsed[1]} mentions on the tag`);
    }
  }

  // ── deleting one, with the warning ────────────────────────────────
  {
    const before = g.state.set.length;
    const counts = (g.state.usage && g.state.usage.counts) || {};
    // Prefer one the game really uses, so the warning has something to say.
    const target = g.state.set.entries.findIndex((e) => counts[e.from] > 0);
    const at = target >= 0 ? target : 0;
    const doomed = g.state.set.entries[at].name;

    document.querySelectorAll('.anim-pick').forEach((b) => { b.checked = false; });
    const box = [...document.querySelectorAll('.anim-pick')][at];
    box.checked = true; box.dispatchEvent(new Event('change'));
    say(!document.querySelector('#btn-delete-anim').disabled,
      'one ticked and the Delete button wakes up');

    const deleting = g.deleteAnims();
    await until('the delete sheet', () => !document.querySelector('#sheet').hidden);
    if (target >= 0) {
      const warn = document.querySelector('#sheet-warn');
      say(!warn.hidden && warn.textContent.includes(doomed),
        `the warning names where the game asks for "${doomed}"`);
      say(/\.(gd|tscn|tres|cs|json|cfg):\d+/.test(warn.textContent),
        'and points at the file and line');
    }
    await answerSheet('Cancel');
    await deleting;
    say(g.state.set.length === before, 'cancelling deletes nothing');

    const again = g.deleteAnims();
    await answerSheet('Delete');
    await again;
    say(g.state.set.length === before - 1, `${doomed} was deleted`);
    say(!g.state.set.names().includes(doomed), 'and is gone from the list');
    say(g.state.set.removed.includes(doomed),
      'and queued to come out of the game file');

    g.undo();
    await wait(120);
    say(g.state.set.names().includes(doomed), 'undo brings it back');
    say(g.state.set.removed.length === 0, 'and unqueues it');
    document.querySelectorAll('.anim-pick').forEach((b) => { b.checked = false; });
    g.renderAnims();
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

    /* (b) Save must not disarm Update the game.
     *
     * Done here rather than on a real character, because Save writes into
     * ~/Documents/gerak/clips and a suite must not put its own keyframes in
     * with his work. The clips it leaves are named after the copy, and
     * tests/run.sh deletes them. */
    {
      const pending = g.state.set.edited().map((e) => e.name).sort();
      say(pending.length > 0, `${pending.length} animation(s) waiting for the game`);
      await document.querySelector('#btn-save').onclick();
      await until('the save', () => !g.state.set.unsavedEntries().length, 15000);

      say(document.querySelector('#btn-save').textContent.trim() === 'Save',
        'the Save dot goes once it is written to the clips folder');
      say(g.state.set.edited().map((e) => e.name).sort().join() === pending.join(),
        'but the game is STILL owed the same animations afterwards');
      say(g.state.set.pending, 'so Update the game is still armed');
    }

    const { clips, remove } = g.state.set.push();
    say(clips.length > 0, `the push carries ${clips.length} edited animation(s) after a Save`);
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
