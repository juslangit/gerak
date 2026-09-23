/* gerak - the app.
 *
 * This file is the wiring. The three pieces it joins together are:
 *
 *   scene.js   what you see and click - the model, its joints, the ring
 *   clip.js    what you author - keys at frames, and the poses between them
 *   server.py  what is on the disk - your models, your saved clips
 *
 * It holds no 3D maths and no animation maths of its own. When something here
 * looks like it is doing real work, it is calling one of those three.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/GLTFExporter.js';
import { Viewport } from '/web/scene.js';
import { Clip, Player } from '/web/clip.js';
import { AnimSet } from '/web/animset.js';
import { detectLimbs, chainFrom, findMirror } from '/web/ik.js';
import { TEMPLATES, TEMPLATE_ORDER, fitTemplate, guessFacing, headsAndTails }
  from '/web/templates.js';
import { History } from '/web/history.js';
import { Reference } from '/web/reference.js';

const $ = (sel) => document.querySelector(sel);
const TOKEN = window.GERAK_TOKEN;

/* Running inside the macOS app rather than a browser tab.
 *
 * Two things change. The window's own title bar is transparent and sits over
 * the page, so the top bar needs room for the traffic lights. And the app's
 * menu bar drives the page from outside, through the commands exposed at the
 * bottom of this file. */
const NATIVE = new URLSearchParams(location.search).get('native') === '1';
if (NATIVE) document.documentElement.classList.add('is-native');

/* Running inside bengkel, with boneka next door.
 *
 * gerak does not know where boneka is or how to reach it, and does not need
 * to: it asks bengkel to carry a file across. Outside bengkel `window.bengkel`
 * is simply not there and none of this happens. */
const INSIDE_BENGKEL = !!window.bengkel;

// ── talking to the server ───────────────────────────────────────────

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Gerak-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

const modelURL = (path) =>
  `/api/model?t=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(path)}`;

// ── the app's whole state, in one place ─────────────────────────────

const state = {
  library: [],
  clip: new Clip(),
  set: new AnimSet(),   // every animation this character has; clip is the open one
  game: null,           // the game project the open model lives in, if any
  model: null,          // the library row that is open
  bones: [],
  frame: 0,
  chains: [],           // the limbs, each either FK or IK
  rig: { template: 'biped', facing: 0, flip: false },
  picked: [],           // keys picked out on the timeline: { name, f }
  source: null,         // the library filter: where a model came from
};

const view = new Viewport($('#viewport'));
const player = new Player((f) => setFrame(f, true));

/* Undo.
 *
 * What is worth photographing is the clip, the pose the joints are actually
 * in, and — while a skeleton is being placed — where its joints sit. Not the
 * camera, not what is selected in the list, not which panels are open: undo
 * should put the work back, not the furniture.
 *
 * The pose is stored as well as the clip because you can turn a joint without
 * keying it. Restoring only the clip would quietly throw that away, which is
 * exactly the pose a person is most likely to want back.
 */

function photograph() {
  return {
    clip: state.clip.toJSON(),
    // The whole animation set, not only the open clip. A merge deletes one
    // animation and edits another, and an undo that put back the clip alone
    // would leave the deleted one deleted.
    set: state.set ? state.set.toJSON() : null,
    frame: state.frame,
    pose: state.bones.map((bone) => ({
      n: bone.name,
      q: bone.quaternion.toArray(),
      p: bone.position.toArray(),
    })),
    draft: view.hasDraft ? view.draftLayout() : null,
    selected: view.selected ? view.selected.name : null,
  };
}

function putBack(shot) {
  // The skeleton itself first: a different template may have been dropped on
  // top since, and the joints have to exist before they can be posed.
  const sameSkeleton = shot.draft && view.hasDraft
    && view.bones.length === shot.draft.length
    && view.bones.every((bone, i) => bone.name === shot.draft[i].name);

  if (shot.draft && !sameSkeleton) {
    state.bones = view.buildDraft(shot.draft);
    state.chains = [];
    renderLimbs();
  } else if (!shot.draft && view.hasDraft) {
    view.clearDraft();
    state.bones = [];
    state.chains = [];
    renderLimbs();
  }

  state.clip = Clip.fromJSON(shot.clip);
  state.clip.dirty = true;
  if (shot.set) state.set.restore(shot.set);
  // The set's own copy of the open entry is the photograph's; the live clip
  // is what is on screen. Point the entry at it so the two do not drift.
  if (state.set.current) state.set.current.clip = state.clip;
  renderAnims();
  $('#length-field').value = state.clip.frames;
  $('#fps-field').value = state.clip.fps;

  // setFrame poses the joints from the clip; the photograph then overwrites
  // that with the exact pose, which is what a joint turned but never keyed
  // needs in order to come back.
  setFrame(shot.frame);
  const byName = new Map(state.bones.map((bone) => [bone.name, bone]));
  for (const posed of shot.pose) {
    const bone = byName.get(posed.n);
    if (!bone) continue;
    bone.quaternion.fromArray(posed.q);
    bone.position.fromArray(posed.p);
  }

  view.scene.updateMatrixWorld(true);
  refreshChains();
  if (shot.selected) view.selectByName(shot.selected); else view.select(null);
  renderBoneTree();
  renderTracks();
  refreshRotationFields();
  updateReadout();
  markDirty();
}

const history = new History(photograph, putBack);

/** Say what will happen if undo is pressed, and grey it out when nothing will. */
function paintHistory() {
  const undo = $('#btn-undo');
  const redo = $('#btn-redo');
  undo.disabled = !history.canUndo;
  redo.disabled = !history.canRedo;
  undo.title = history.canUndo ? `Undo ${history.undoLabel}` : 'Nothing to undo';
  redo.title = history.canRedo ? `Redo ${history.redoLabel}` : 'Nothing to redo';
}
history.onChange = paintHistory;

function undo() {
  const what = history.undo();
  toast(what ? `Undid ${what}.` : 'Nothing to undo.');
}

function redo() {
  const what = history.redo();
  toast(what ? `Redid ${what}.` : 'Nothing to redo.');
}

$('#btn-undo').onclick = undo;
$('#btn-redo').onclick = redo;

/* Copy and paste.
 *
 * Two different things get copied depending on what you have picked out, and
 * the difference is worth stating because it decides what paste does:
 *
 *   nothing picked   the whole pose at the playhead, sampled — so a frame
 *                    with no key on it still copies, which is what "copy the
 *                    pose" has to mean
 *   keys picked      exactly those keys, keeping the gaps between them
 *
 * Either way what is stored is joint names and rotations, not frame numbers,
 * so a pose copied off one character pastes onto another with the same rig —
 * which is most of his, because they came out of the same generator.
 *
 * Paste anchors at the playhead: the earliest thing copied lands there and
 * everything else keeps its distance from it.
 */

const CLIPBOARD_KEY = 'gerak.clipboard';
let clipboard = null;

function rememberClipboard() {
  try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clipboard)); } catch { /* fine */ }
}

function recallClipboard() {
  try {
    const stored = localStorage.getItem(CLIPBOARD_KEY);
    if (stored) clipboard = JSON.parse(stored);
  } catch { clipboard = null; }
}

/** The other side of the body, and the rotation that goes with it. */
function flipEntry(entry, names) {
  return {
    // A joint with no opposite number - a spine, a head - keeps its own name
    // and is simply mirrored in place, which is what a centre joint should do.
    name: findMirror(entry.name, names) || entry.name,
    offset: entry.offset,
    // A rig puts the two sides of a body at mirrored positions along X, so
    // flipping the sign of the Y and Z parts of a rotation is the right
    // answer for the great majority of them. Same caveat as the Mirror
    // button: look at the result.
    q: [entry.q[0], -entry.q[1], -entry.q[2], entry.q[3]],
    p: [-entry.p[0], entry.p[1], entry.p[2]],
  };
}

function copyKeys() {
  if (!state.bones.length) return;

  let entries;
  let label;

  if (state.picked.length) {
    const earliest = Math.min(...state.picked.map((k) => k.f));
    entries = state.picked.map(({ name, f }) => {
      const key = state.clip.keysOf(name).find((k) => k.f === f);
      return key && { name, offset: f - earliest, q: key.q.slice(), p: key.p.slice() };
    }).filter(Boolean);
    label = `${entries.length} key${entries.length === 1 ? '' : 's'}`;
  } else {
    const frame = Math.round(state.frame);
    entries = state.clip.poseAt(frame).map((posed) => ({ ...posed, offset: 0 }));
    label = `the pose at frame ${frame}`;
  }

  if (!entries.length) {
    toast('Nothing to copy — key a pose first.');
    return;
  }

  clipboard = {
    label,
    from: state.model ? state.model.name : '',
    joints: new Set(entries.map((e) => e.name)).size,
    span: Math.max(...entries.map((e) => e.offset)),
    entries,
  };
  rememberClipboard();
  paintClipboard();
  toast(`Copied ${label} — ${clipboard.joints} joint${clipboard.joints === 1 ? '' : 's'}.`);
}

function pasteKeys({ flipped = false } = {}) {
  if (!clipboard || !clipboard.entries.length) { toast('Nothing has been copied yet.'); return; }
  if (!state.bones.length) return;

  const at = Math.round(state.frame);
  const here = new Set(state.bones.map((b) => b.name));
  const names = [...here];
  const landing = (flipped ? clipboard.entries.map((e) => flipEntry(e, names)) : clipboard.entries)
    .filter((entry) => here.has(entry.name));

  if (!landing.length) {
    toast(flipped
      ? 'None of those joints have an opposite number on this model.'
      : `None of those joints are on this model — it was copied from ${clipboard.from}.`, true);
    return;
  }

  history.push(`pasting ${clipboard.label}${flipped ? ', flipped' : ''}`);

  for (const entry of landing) {
    state.clip.setKeyValues(entry.name, at + entry.offset, entry.q, entry.p);
  }

  // A paste that runs past the end of the clip lengthens it rather than
  // dropping the keys off the end where they cannot be seen.
  const last = at + clipboard.span;
  if (last > state.clip.frames) {
    state.clip.frames = last;
    $('#length-field').value = last;
  }

  state.picked = [];
  setFrame(at);
  renderTracks();
  paintBoneTree();
  markDirty();

  const skipped = clipboard.entries.length - landing.length;
  toast(`Pasted ${landing.length} key${landing.length === 1 ? '' : 's'} at frame ${at}`
    + (flipped ? ', flipped' : '')
    + (skipped ? ` — ${skipped} joint${skipped === 1 ? '' : 's'} not on this model` : '') + '.');
}

/** Keep the three buttons saying what they will actually do. */
function paintClipboard() {
  const copy = $('#btn-copy');
  const paste = $('#btn-paste');
  const flip = $('#btn-paste-flip');

  copy.title = state.picked.length
    ? `Copy the ${state.picked.length} picked key${state.picked.length === 1 ? '' : 's'}`
    : `Copy the pose at frame ${Math.round(state.frame)}`;

  const has = !!(clipboard && clipboard.entries.length);
  paste.disabled = !has;
  flip.disabled = !has;
  paste.title = has ? `Paste ${clipboard.label} at this frame` : 'Nothing has been copied yet';
  flip.title = has
    ? `Paste ${clipboard.label} with left and right swapped`
    : 'Nothing has been copied yet';
}

$('#btn-copy').onclick = () => copyKeys();
$('#btn-paste').onclick = () => pasteKeys();
$('#btn-paste-flip').onclick = () => pasteKeys({ flipped: true });

// ── little helpers ──────────────────────────────────────────────────

let toastTimer = null;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('is-bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 5200 : 2600);
}

const kb = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

/* Asking a question that has more than a yes in it.
 *
 * The browser's own confirm() only offers two answers, and inside gerak.app
 * it is not a browser dialog at all — WKWebView turns it into a real Mac
 * sheet, and a pending sheet blocks every other piece of JavaScript on the
 * page, including whatever is waiting for the answer. Merging needs three
 * answers and a warning list, so it gets a panel in the page instead.
 *
 * Resolves to the id of the button that was pressed, or null for cancel.
 */
function sheet({ title, body, warn = '', actions }) {
  const el = $('#sheet');
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = body;
  $('#sheet-warn').innerHTML = warn;
  $('#sheet-warn').hidden = !warn;

  return new Promise((resolve) => {
    const done = (value) => {
      el.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      done(null);
    };

    const row = $('#sheet-actions');
    row.innerHTML = '';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.className = `btn${action.primary ? ' btn-primary' : ''}`;
      btn.textContent = action.label;
      btn.onclick = () => done(action.id);
      row.appendChild(btn);
    }

    el.hidden = false;
    document.addEventListener('keydown', onKey, true);
    const first = row.querySelector('.btn-primary') || row.firstChild;
    if (first) first.focus();
  });
}

/* Meshy and Blender rigs use different spellings for the same bone. This makes
 * "LeftArm", "arm.L", "Bip01_L_UpperArm" and "hand_l" all readable at a glance
 * without losing which side they are on. */
function prettyBone(name) {
  return name
    .replace(/^(mixamorig|Bip\d*|Armature)[:_|]?/i, '')
    // Meshy hangs a node number on the end of every bone - "Hips_34". It is
    // meaningless to read and it is not part of the name, so it goes.
    .replace(/[_.]\d+$/, '')
    .replace(/[_.]/g, ' ')
    .replace(/\b(l|left)\b/i, 'L')
    .replace(/\b(r|right)\b/i, 'R')
    .trim() || name;
}

// ── the library ─────────────────────────────────────────────────────

async function loadLibrary(refresh = false) {
  const btn = $('#btn-rescan');
  btn.classList.add('is-spinning');
  try {
    const { items } = await api(`/api/library?t=${encodeURIComponent(TOKEN)}${refresh ? '&refresh=1' : ''}`);
    state.library = items;
    renderLibrary();
    return items;
  } catch (err) {
    $('#library-list').innerHTML = `<p class="hint">Could not read the library: ${err.message}</p>`;
  } finally {
    btn.classList.remove('is-spinning');
  }
}

/**
 * Where a model came from, in one word.
 *
 * The list is 3,400 rows long and the folder path is the only thing that says
 * where a model came from — but reading `~/Desktop/project/ai/boneka/sessions`
 * off every row is not the same as being able to ask for everything boneka
 * made. So each row gets a short source, and the sources become a row of
 * chips above the list.
 */
function sourceOf(item) {
  const path = item.path;
  if (/\/boneka\/sessions\//.test(path)) return 'boneka';
  if (/\/Documents\/gerak\/exports\//.test(path)) return 'gerak exports';
  if (/\/Documents\/bengkel\//.test(path)) return 'bengkel';
  const inProject = path.match(/\/Desktop\/project\/[^/]+\/([^/]+)\//);
  if (inProject) return inProject[1];
  if (/\/Downloads\//.test(path)) return 'Downloads';
  return 'elsewhere';
}

function renderSources() {
  const row = $('#source-row');
  const counts = new Map();
  for (const item of state.library) {
    if ($('#only-rigged').checked && !item.rigged) continue;
    const source = sourceOf(item);
    counts.set(source, (counts.get(source) || 0) + 1);
  }

  // Most first, but boneka pinned to the front — it is the tool next door,
  // and what it made is the most likely thing to want.
  const sources = [...counts.entries()].sort((a, b) => {
    if (a[0] === 'boneka') return -1;
    if (b[0] === 'boneka') return 1;
    return b[1] - a[1];
  });

  row.innerHTML = `<button class="chip-filter${state.source ? '' : ' is-on'}" data-source="">`
    + `All <span>${[...counts.values()].reduce((a, b) => a + b, 0)}</span></button>`
    + sources.map(([source, n]) =>
      `<button class="chip-filter${state.source === source ? ' is-on' : ''}" `
      + `data-source="${escapeHTML(source)}">${escapeHTML(source)} <span>${n}</span></button>`).join('');

  row.querySelectorAll('.chip-filter').forEach((chip) => {
    chip.onclick = () => {
      state.source = chip.dataset.source || null;
      renderLibrary();
    };
  });
}

function renderLibrary() {
  const q = $('#library-search').value.trim().toLowerCase();
  const onlyRigged = $('#only-rigged').checked;
  const list = $('#library-list');

  renderSources();

  let items = state.library;
  if (onlyRigged) items = items.filter((i) => i.rigged);
  if (state.source) items = items.filter((i) => sourceOf(i) === state.source);
  if (q) items = items.filter((i) =>
    i.name.toLowerCase().includes(q) || i.folder.toLowerCase().includes(q));

  if (!items.length) {
    list.innerHTML = `<p class="hint">${onlyRigged
      ? 'No model here has a skeleton in it yet. Untick the box to see everything — placing joints on a bare model comes next.'
      : 'Nothing matched.'}</p>`;
    return;
  }

  const shown = items.slice(0, 400);
  list.innerHTML = shown.map((item, i) => `
    <button class="row${state.model && state.model.path === item.path ? ' is-on' : ''}" data-i="${i}">
      <div class="row-name">${escapeHTML(item.name)}</div>
      <div class="row-meta">${escapeHTML(item.folder.replace('~/Desktop/project/', ''))}</div>
      <div class="row-tags">
        ${item.rigged ? `<span class="tag tag-rig">${item.joints} joints</span>` : ''}
        ${item.anims ? `<span class="tag tag-anim">${item.anims} animation${item.anims > 1 ? 's' : ''}</span>` : ''}
        <span class="tag">${item.ext}</span>
        <span class="tag">${kb(item.size)}</span>
      </div>
    </button>`).join('') +
    (items.length > shown.length
      ? `<p class="hint">${items.length - shown.length} more — narrow it with the search box.</p>` : '');

  list.querySelectorAll('.row').forEach((row) => {
    row.onclick = () => openModel(shown[+row.dataset.i]);
  });
}

/* localStorage is not always there - a private window, or storage turned off -
 * and reading it can throw rather than return nothing, so both directions are
 * wrapped and the app works the same either way. */
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* nothing to do */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── opening a model ─────────────────────────────────────────────────

async function openModel(item) {
  if (state.set.dirty
      && !confirm('Some animations have unsaved edits. Open another model anyway?')) return;

  toast(`Opening ${item.name}…`);
  player.pause();

  try {
    const info = await view.load(modelURL(item.path));
    state.model = item;
    state.bones = info.bones;
    state.chains = [];
    state.set = AnimSet.fromModel(item, info.clips);
    state.clip = new Clip({
      name: item.name.replace(/\.(glb|gltf|fbx)$/i, ''),
      model: item.path,
      fps: +$('#fps-field').value || 24,
      frames: +$('#length-field').value || 48,
    });

    $('#viewport-empty').hidden = true;
    $('#loaded-name').innerHTML =
      `<strong>${escapeHTML(item.name)}</strong> — ` +
      (info.bones.length ? `${info.bones.length} joints` : 'no skeleton yet') +
      (info.clips.length ? `, ${info.clips.length} animation${info.clips.length > 1 ? 's' : ''} in the file` : '');
    $('#btn-save').disabled = false;
    $('#btn-export').disabled = false;

    const boneless = state.bones.length === 0;
    showRigPanel(boneless);
    if (boneless) {
      setFacing(guessFacing(state.rig.template, view.modelBox()));
      view.setGizmoMode('translate');
      document.querySelector('[data-gizmo="translate"]').classList.add('is-on');
      document.querySelector('[data-gizmo="rotate"]').classList.remove('is-on');
    }

    history.clear();
    state.picked = [];
    state.chains = boneless ? [] : detectLimbs(state.bones);
    renderBoneTree();
    renderLimbs();
    setFrame(0);
    renderTracks();

    /* Whatever animations the file came with are now the panel, and the
     * first of them is open. It used to be a prompt asking you to pick one,
     * which meant eleven of a character's twelve were unreachable without
     * opening the file again. */
    await whichGame(item.path);
    openAnim(0, { quiet: true });

    remember('gerak.lastModel', item.path);
    document.title = `${item.name} — gerak`;
    const has = info.clips.length;
    toast(has
      ? `${item.name} is open — ${has} animation${has === 1 ? '' : 's'} in the Animations tab.`
      : `${item.name} is open — click a joint to start.`);
  } catch (err) {
    console.error(err);
    /* The list is built from a scan that may be up to an hour old, so a row
     * can outlive the file it names — move a model in Finder and gerak would
     * offer you something that is no longer there. Rather than leave a dead
     * row to be clicked again, scan afresh and say so. */
    toast(`Could not open ${item.name} — it may have moved. Scanning again…`, true);
    const found = await loadLibrary(true);
    const still = found && found.some((i) => i.path === item.path);
    if (!still) toast(`${item.name} is no longer where it was; the list is up to date now.`, true);
  }
  renderLibrary();
}

/* ── the animations this character has ───────────────────────────────
 *
 * A rigged character is rarely one animation. `athlete_tall.glb` carries
 * twelve, and the game plays them by name, so "edit the animation" has to
 * mean "edit any of the twelve, whenever you like" rather than "pick one on
 * the way in and live with it".
 *
 * Everything here is in memory. Switching animations writes nothing; Save
 * writes your clips into ~/Documents/gerak; Update the game writes into the
 * game's own file. Three separate acts, three separate buttons.
 */

function renderAnims() {
  const list = $('#anim-list');
  const where = $('#anim-where');
  if (!list) return;

  if (!state.model) {
    where.textContent = 'Open a character to see its animations.';
    list.innerHTML = '';
    $('#btn-merge').disabled = true;
    return;
  }

  const set = state.set;
  where.innerHTML = `<strong>${escapeHTML(state.model.name)}</strong> — `
    + `${set.length} animation${set.length === 1 ? '' : 's'}`
    + (state.game && state.game.here
       ? ` · in ${escapeHTML(state.game.here.game)}` : '');

  list.innerHTML = set.entries.map((entry, i) => {
    const clip = entry.clip;
    const keys = clip ? clip.totalKeys() : null;
    const frames = clip ? clip.frames
      : (set.sources.get(entry.from) ? Math.round(set.sources.get(entry.from).duration * 24) : 0);
    return `
      <div class="row anim-row ${i === set.at ? 'is-open' : ''}" data-i="${i}">
        <label class="anim-tick" title="Tick two to merge them">
          <input type="checkbox" class="anim-pick" data-i="${i}">
        </label>
        <button class="anim-open" data-i="${i}">
          <span class="row-name">${escapeHTML(entry.name)}${entry.dirty ? ' <span class="dot">•</span>' : ''}</span>
          <span class="row-tags">
            <span class="tag">${frames} frames</span>
            ${keys === null ? '<span class="tag tag-quiet">not opened yet</span>'
                            : `<span class="tag tag-rig">${keys} keys</span>`}
          </span>
        </button>
      </div>`;
  }).join('');

  list.querySelectorAll('.anim-open').forEach((btn) => {
    btn.onclick = () => openAnim(+btn.dataset.i);
  });
  list.querySelectorAll('.anim-pick').forEach((box) => {
    box.onchange = paintMergeButton;
  });
  paintMergeButton();
}

function pickedAnims() {
  return [...document.querySelectorAll('.anim-pick')]
    .filter((b) => b.checked).map((b) => +b.dataset.i);
}

function paintMergeButton() {
  const picked = pickedAnims();
  const btn = $('#btn-merge');
  btn.disabled = picked.length !== 2;
  $('#anim-note').textContent = picked.length === 2
    ? `${state.set.entries[picked[0]].name} and ${state.set.entries[picked[1]].name}`
    : picked.length ? 'Tick one more.' : '';
}

/**
 * Put down the animation being edited and pick up another.
 *
 * The first time one is opened it is read out of the file and sampled into
 * keys, which is why an animation says "not opened yet" until you touch it —
 * doing that to all twelve on open would make every character slow to look
 * at for the sake of eleven you were not going to edit.
 */
function openAnim(i, { quiet = false } = {}) {
  const set = state.set;
  if (i < 0 || i >= set.length) return;
  if (i === set.at && set.current && set.current.clip === state.clip) return;

  player.pause();
  set.stash(state.clip);

  const clip = set.open(i, (source) =>
    Clip.fromAnimationClip(source, state.bones, view.restPose,
                           +$('#fps-field').value || 24));
  if (!clip) return;

  state.clip = clip;
  state.picked = [];
  reference.fromJSON(clip.reference);
  $('#fps-field').value = clip.fps;
  $('#length-field').value = clip.frames;

  /* An animation is a different piece of work from the one before it, so the
   * undo stack starts again here. Undoing across a switch would put keys from
   * one animation back into another. */
  history.clear();
  setFrame(0);
  renderBoneTree();
  renderTracks();
  renderAnims();
  paintSaveState();
  if (!quiet) {
    toast(`Editing "${clip.name}" — ${clip.totalKeys()} keys on ${clip.tracks.size} joints.`);
  }
}

/**
 * Merge two of them into one.
 *
 * His case: a character has two runs for two different occasions and he
 * wants both occasions to look the same. So this is not a blend — it is
 * choosing which of the two motions survives. The other is deleted, and
 * because a Godot script plays an animation by its name, gerak looks through
 * the game's own files first and shows every line that says the name out
 * loud before it offers to go ahead.
 */
async function mergeAnims() {
  const picked = pickedAnims();
  if (picked.length !== 2) return;
  const [a, b] = picked.map((i) => state.set.entries[i]);

  const hits = await mentionsOf([a.name, b.name]);
  const warnFor = (name) => {
    const found = hits[name] || [];
    if (!found.length) return '';
    return `<p><strong>${escapeHTML(name)}</strong> is named in `
      + `${found.length} place${found.length === 1 ? '' : 's'} in the game:</p>`
      + '<ul>' + found.slice(0, 6).map((h) =>
        `<li><code>${escapeHTML(h.file)}:${h.line}</code> ${escapeHTML(h.text)}</li>`).join('')
      + '</ul>'
      + (found.length > 6 ? `<p>…and ${found.length - 6} more.</p>` : '');
  };

  const answer = await sheet({
    title: `Merge "${a.name}" and "${b.name}"`,
    body: `<p>Both will become one animation. Which motion do you want to keep?
           The other one is deleted — from the list now, and from the game's
           file the next time you press Update&nbsp;the&nbsp;game.</p>`,
    warn: warnFor(a.name) + warnFor(b.name),
    actions: [
      { id: 'a', label: `Keep "${a.name}"`, primary: true },
      { id: 'b', label: `Keep "${b.name}"` },
      { id: null, label: 'Cancel' },
    ],
  });
  if (!answer) return;

  const keep = answer === 'a' ? picked[0] : picked[1];
  const drop = answer === 'a' ? picked[1] : picked[0];
  const dropped = state.set.entries[drop].name;

  history.push(`merging "${a.name}" and "${b.name}"`);
  const done = state.set.merge(keep, drop, (source) =>
    Clip.fromAnimationClip(source, state.bones, view.restPose,
                           +$('#fps-field').value || 24));
  if (!done) return;

  // If the one that went was the one on screen, the keeper is now open.
  if (state.set.current) state.clip = state.set.current.clip;
  setFrame(0);
  renderTracks();
  renderAnims();
  paintSaveState();
  toast(`Kept "${done.kept}" and deleted "${dropped}". `
        + 'Press Update the game to make it so in the file.');
}

/** Where the game's own files say these animation names out loud. */
async function mentionsOf(names) {
  if (!state.model || !(state.game && state.game.here)) return {};
  try {
    const { hits } = await api('/api/mentions', { model: state.model.path, names });
    return hits || {};
  } catch { return {}; }
}

/** Which game project the open model belongs to, if it belongs to one. */
async function whichGame(path) {
  state.game = null;
  try {
    state.game = await api(
      `/api/games?t=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(path)}`);
  } catch { /* the button simply stays off */ }
  paintSaveState();
  return state.game;
}

$('#btn-merge').onclick = mergeAnims;

// ── the joint tree ──────────────────────────────────────────────────

function renderBoneTree() {
  const tree = $('#bone-tree');
  if (!state.bones.length) {
    tree.innerHTML = '<p class="hint">No skeleton yet — place one above, and '
      + 'its joints will appear here.</p>';
    return;
  }

  // Lay the bones out as the tree they really are, so a hand reads as living
  // under an arm rather than as one more name in a flat list.
  const boneSet = new Set(state.bones);
  const rows = [];
  const walk = (bone, depth) => {
    rows.push({ bone, depth });
    for (const child of bone.children) if (boneSet.has(child)) walk(child, depth + 1);
  };
  for (const bone of state.bones) if (!boneSet.has(bone.parent)) walk(bone, 0);

  tree.innerHTML = rows.map(({ bone, depth }) => `
    <button class="bone" data-name="${escapeHTML(bone.name)}"
            style="padding-left:${10 + depth * 14}px">
      <span class="bone-dot"></span>
      <span class="bone-label">${escapeHTML(prettyBone(bone.name))}</span>
    </button>`).join('');

  tree.querySelectorAll('.bone').forEach((el) => {
    el.onclick = () => view.selectByName(el.dataset.name);
  });
  paintBoneTree();
}

function paintBoneTree() {
  const sel = view.selected ? view.selected.name : null;
  $('#bone-tree').querySelectorAll('.bone').forEach((el) => {
    const name = el.dataset.name;
    el.classList.toggle('is-on', name === sel);
    el.classList.toggle('has-keys', state.clip.tracks.has(name));
  });
}

/**
 * Open a file by its path on disk, wherever it is.
 *
 * The library only knows the folders gerak scans. A file dropped on the
 * window, chosen in the app's Open dialog, or handed over by Finder may be
 * anywhere, so it is first permitted - which only something holding this
 * run's token can do - and then described in the same shape a library row
 * has, so from here on it is an ordinary model.
 */
async function openPath(path) {
  try {
    const permitted = await api('/api/permit', { path });
    if (!permitted.ok) throw new Error('that file could not be read');
    const item = await api(
      `/api/describe?t=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(path)}`);
    if (item.ext && !['glb', 'gltf'].includes(item.ext)) {
      toast(`gerak opens .glb and .gltf for now — ${item.name} is a .${item.ext}.`, true);
      return false;
    }
    await openModel(item);
    return true;
  } catch (err) {
    toast(`Could not open that file: ${err.message}`, true);
    return false;
  }
}

// ── putting a skeleton on a model that has none ─────────────────────

$('#rig-template').innerHTML = TEMPLATE_ORDER
  .map((key) => `<option value="${key}">${escapeHTML(TEMPLATES[key].label)}</option>`).join('');

function showRigPanel(on) {
  $('#rig-box').hidden = !on;
  if (!on) return;
  $('#rig-template').value = state.rig.template;
  showTemplateNote();
  $('#btn-bind').hidden = true;
  $('#rig-status').textContent = '';
  $('#rig-status').className = 'rig-note';
  setFacing(state.rig.facing);
}

function setFacing(deg) {
  state.rig.facing = deg;
  $('#rig-facing').querySelectorAll('[data-facing]').forEach((b) =>
    b.classList.toggle('is-on', +b.dataset.facing === deg));
}

/* The joint count is counted, never written down. A hand-written "23 joints"
 * in a note is wrong the moment a joint is added to the template. */
function showTemplateNote() {
  const tpl = TEMPLATES[state.rig.template];
  $('#rig-template-note').textContent = `${tpl.note} ${tpl.joints.length} joints.`;
}

$('#rig-template').onchange = (e) => {
  state.rig.template = e.target.value;
  showTemplateNote();
  if (state.model) setFacing(guessFacing(state.rig.template, view.modelBox()));
  if (view.hasDraft) placeSkeleton();
};
$('#rig-facing').querySelectorAll('[data-facing]').forEach((btn) => {
  btn.onclick = () => { setFacing(+btn.dataset.facing); if (view.hasDraft) placeSkeleton(); };
});
$('#rig-flip').onchange = (e) => {
  state.rig.flip = e.target.checked;
  if (view.hasDraft) placeSkeleton();
};

function placeSkeleton() {
  history.push(view.hasDraft ? 'placing a different skeleton' : 'placing a skeleton');
  const placed = fitTemplate(
    state.rig.template, view.modelBox(), state.rig.facing, state.rig.flip);
  const bones = view.buildDraft(placed);
  state.bones = bones;
  state.chains = [];
  renderLimbs();
  renderBoneTree();
  renderTracks();
  $('#btn-bind').hidden = false;
  $('#rig-status').className = 'rig-note';
  $('#rig-status').textContent =
    `${bones.length} joints placed. Drag any of them onto the right part of the `
    + 'model — the joints below a joint come with it — then bind.';
  toast(`${TEMPLATES[state.rig.template].label} skeleton placed — nudge the joints, then bind.`);
}

$('#btn-place').onclick = () => {
  if (!state.model) return;
  placeSkeleton();
};

$('#btn-bind').onclick = async () => {
  if (!view.hasDraft) return;
  const btn = $('#btn-bind');
  const status = $('#rig-status');
  btn.disabled = true;
  btn.textContent = 'Blender is binding…';
  status.className = 'rig-note';
  status.textContent = 'Working out which part of the skin each bone moves. '
    + 'This takes a few seconds.';

  try {
    const joints = headsAndTails(view.draftJoints());
    const result = await api('/api/rig', {
      source: state.model.path,
      joints,
      name: state.model.name.replace(/\.\w+$/, ''),
    });
    if (!result.ok) throw new Error((result.problems || ['Blender failed']).join('; '));

    const stranded = result.unweighted
      ? `\n${result.unweighted} of ${result.vertices} vertices were not reached by any bone `
        + '— those parts will not move. Move a joint closer and bind again if that matters.'
      : '';
    status.className = 'rig-note is-good';
    status.textContent = `Bound with ${result.weights}. ${result.bones} bones, `
      + `${result.vertices} vertices.${stranded}`;

    // Open the rigged copy. The original file is never touched.
    view.clearDraft();
    await openModel({
      path: result.out,
      name: result.out.split('/').pop(),
      folder: result.shown.replace(/\/[^/]+$/, ''),
      ext: 'glb',
      size: result.bytes,
      rigged: true,
      joints: result.bones,
      anims: 0,
    });
    toast(`Rigged — ${result.bones} bones. Click a joint and start posing.`);
    loadLibrary(true);
  } catch (err) {
    status.className = 'rig-note is-bad';
    status.textContent = `Could not bind: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Bind the skin to it';
  }
};

// ── limbs: FK or IK ─────────────────────────────────────────────────

function renderLimbs() {
  const box = $('#limbs-box');
  const list = $('#limb-list');
  box.hidden = !state.chains.length;
  if (!state.chains.length) return;

  list.innerHTML = state.chains.map((chain, i) => `
    <div class="limb-row${chain.enabled ? ' is-ik' : ''}" data-i="${i}">
      <span class="limb-name" title="${escapeHTML(chain.bones.map((b) => b.name).join(' → '))}">${escapeHTML(chain.label)}</span>
      <span class="mode-toggle">
        <button data-mode="fk" class="${chain.enabled ? '' : 'is-on'}">FK</button>
        <button data-mode="ik" class="${chain.enabled ? 'is-on' : ''}">IK</button>
      </span>
      <button class="pin-btn${chain.pinned ? ' is-on' : ''}" title="Pin it in place"
              ${chain.enabled ? '' : 'disabled'}>📌</button>
    </div>`).join('');

  list.querySelectorAll('.limb-row').forEach((row) => {
    const chain = state.chains[+row.dataset.i];
    row.querySelectorAll('.mode-toggle button').forEach((btn) => {
      btn.onclick = () => setChainMode(chain, btn.dataset.mode);
    });
    row.querySelector('.pin-btn').onclick = () => togglePin(chain);
  });
}

function setChainMode(chain, mode) {
  const on = mode === 'ik';
  if (chain.enabled === on) return;
  chain.enabled = on;
  if (on) {
    // Take the handle from wherever the limb is standing right now, so
    // switching to IK never moves the model.
    view.scene.updateMatrixWorld(true);
    chain.capture();
    view.addHandle(chain);
    toast(`${chain.label} is on IK — drag the green diamond.`);
  } else {
    chain.pinned = false;
    view.removeHandle(chain);
    toast(`${chain.label} is back on FK — turn its joints directly.`);
  }
  view.syncHandles();
  renderLimbs();
}

function togglePin(chain) {
  if (!chain.enabled) return;
  chain.pinned = !chain.pinned;
  if (chain.pinned) {
    view.scene.updateMatrixWorld(true);
    chain.capture();
    toast(`${chain.label} is pinned — it stays put while you move the body.`);
  }
  view.syncHandles();
  renderLimbs();
}

/**
 * Re-plant every pinned limb.
 *
 * This is what "pinned" means in practice: you move the hips, and before
 * anything is keyed the pinned foot is solved back onto the spot it was
 * standing on. Called after a joint is moved by hand, never during playback -
 * playback plays the keys, and the keys already have the pinning baked in.
 */
function applyPins(except = null) {
  const moved = [];
  for (const chain of state.chains) {
    if (!chain.enabled || !chain.pinned || chain === except) continue;
    view.scene.updateMatrixWorld(true);
    chain.solve(chain.target);
    moved.push(...chain.bones);
  }
  if (moved.length) view.syncHandles();
  return moved;
}

/** Take the handles along with the pose, so they never lag behind the model. */
function refreshChains() {
  if (!state.chains.length) return;
  view.scene.updateMatrixWorld(true);
  for (const chain of state.chains) {
    if (chain.enabled && !chain.pinned) chain.capture();
  }
  view.syncHandles();
}

// Dragging a green diamond solves that limb, live, as you move it.
view.onHandleMoved = (chain, position) => {
  chain.solve(position);
  updateReadout();
};

view.onHandleDropped = (chain) => {
  const bones = chain.bones.concat(applyPins(chain));
  if ($('#chk-autokey').checked) keyBones(bones, state.frame);
  toast(`${chain.label} posed${$('#chk-autokey').checked ? ` and keyed at frame ${Math.round(state.frame)}` : ''}.`);
};

$('#btn-make-chain').onclick = () => {
  const bone = view.selected;
  if (!bone) return;
  const chain = chainFrom(bone, state.bones, 3);
  if (!chain) { toast('That joint has nothing above it to make a chain from.', true); return; }
  if (state.chains.some((c) => c.name === chain.name)) {
    toast('There is already a chain ending at that joint.'); return;
  }
  chain.label = prettyBone(bone.name);
  state.chains.push(chain);
  renderLimbs();
  setChainMode(chain, 'ik');
};

// ── selection ───────────────────────────────────────────────────────

view.onSelect = (bone) => {
  $('#selected-box').hidden = !bone;
  if (bone) {
    $('#selected-name').textContent = prettyBone(bone.name);
    $('#selected-name').title = bone.name;
    refreshRotationFields();
  }
  paintBoneTree();
  renderTracks();
  updateReadout();
};

// Dragging the ring writes a key the moment you let go, if auto-key is on.
view.onDragStart = (what) => {
  if (!what) return;
  history.push(what.bones ? `moving ${what.label}` : `turning ${prettyBone(what.name)}`);
};

view.onDragEnd = (bone) => {
  const alsoMoved = applyPins();
  if ($('#chk-autokey').checked) keyBones([bone, ...alsoMoved], state.frame);
  refreshChains();
  refreshRotationFields();
  updateReadout();
};

view.onJointChanged = () => { refreshRotationFields(); updateReadout(); };

function refreshRotationFields() {
  const bone = view.selected;
  if (!bone) return;
  const e = new THREE.Euler().setFromQuaternion(bone.quaternion, 'XYZ');
  const deg = (r) => Math.round(THREE.MathUtils.radToDeg(r) * 10) / 10;
  $('#rot-grid').querySelectorAll('input').forEach((input) => {
    if (document.activeElement === input) return;
    input.value = deg(e[input.dataset.axis]);
  });
}

$('#rot-grid').querySelectorAll('input').forEach((input) => {
  input.addEventListener('focus', () => {
    if (view.selected) history.push(`turning ${prettyBone(view.selected.name)}`);
  });
  input.addEventListener('input', () => {
    const bone = view.selected;
    if (!bone) return;
    const e = new THREE.Euler(
      THREE.MathUtils.degToRad(+$('#rot-grid input[data-axis="x"]').value || 0),
      THREE.MathUtils.degToRad(+$('#rot-grid input[data-axis="y"]').value || 0),
      THREE.MathUtils.degToRad(+$('#rot-grid input[data-axis="z"]').value || 0),
      'XYZ');
    bone.quaternion.setFromEuler(e);
    if ($('#chk-autokey').checked) keyBone(bone, state.frame);
    updateReadout();
  });
});

function updateReadout() {
  const bone = view.selected;
  if (!bone) { $('#readout').textContent = ''; return; }
  const e = new THREE.Euler().setFromQuaternion(bone.quaternion, 'XYZ');
  const d = (r) => THREE.MathUtils.radToDeg(r).toFixed(1).padStart(7);
  const keys = state.clip.keysOf(bone.name).length;
  $('#readout').textContent =
    `${prettyBone(bone.name)}\n` +
    `X ${d(e.x)}°   Y ${d(e.y)}°   Z ${d(e.z)}°\n` +
    `${keys} key${keys === 1 ? '' : 's'} on this joint`;
}

// ── keys ────────────────────────────────────────────────────────────

function keyBone(bone, frame) {
  keyBones([bone], frame);
}

/** One key per bone, then one redraw - not one redraw per bone. */
function keyBones(bones, frame) {
  const seen = new Set();
  for (const bone of bones) {
    if (seen.has(bone.name)) continue;
    seen.add(bone.name);
    state.clip.setKey(bone.name, frame, bone.quaternion, bone.position);
  }
  renderTracks();
  paintBoneTree();
  markDirty();
}

/** Key every joint that has moved away from the pose the file arrived in. */
function keyPose(frame = state.frame) {
  if (!state.bones.length) return;

  // Work out what would be keyed before keying any of it, so that a press
  // that changes nothing does not leave a dead step on the undo stack.
  const keying = state.bones.filter((bone) => {
    const rest = view.restPose.get(bone.name);
    const moved = !rest
      || Math.abs(bone.quaternion.dot(rest.q)) < 0.999999
      || bone.position.distanceToSquared(rest.p) > 1e-12;
    // Already-keyed joints are re-keyed too, so a pose is stored whole and
    // does not half-change when you scrub back to it.
    return moved || state.clip.tracks.has(bone.name);
  });

  if (!keying.length) { toast('Nothing has moved yet — turn a joint first.'); return; }

  history.push(`keying frame ${Math.round(frame)}`);
  for (const bone of keying) {
    state.clip.setKey(bone.name, frame, bone.quaternion, bone.position);
  }
  renderTracks();
  paintBoneTree();
  markDirty();
  toast(`Keyed ${keying.length} joint${keying.length === 1 ? '' : 's'} at frame ${Math.round(frame)}.`);
}

function removeKeyHere() {
  const bone = view.selected;
  const frame = Math.round(state.frame);

  // Same again: find the keys first, so pressing Delete on a frame with none
  // does not become a step you have to undo past.
  // Keys picked out on the timeline win: they are an explicit choice, where
  // the playhead is only where you happen to be standing.
  if (state.picked.length) {
    const picked = state.picked.slice();
    history.push(`removing ${picked.length} picked key${picked.length === 1 ? '' : 's'}`);
    for (const { name, f } of picked) state.clip.removeKey(name, f);
    state.picked = [];
    toast(`Removed ${picked.length} key${picked.length === 1 ? '' : 's'}.`);
    setFrame(state.frame);
    renderTracks();
    paintBoneTree();
    markDirty();
    return;
  }

  const names = bone
    ? (state.clip.hasKey(bone.name, frame) ? [bone.name] : [])
    : state.clip.keyedNames().filter((name) => state.clip.hasKey(name, frame));

  if (!names.length) {
    toast(bone ? 'No key on that joint at this frame.' : 'No keys at this frame.');
    return;
  }

  history.push(`removing ${names.length === 1 ? 'a key' : names.length + ' keys'} at frame ${frame}`);
  for (const name of names) state.clip.removeKey(name, frame);

  toast(names.length === 1 && bone
    ? `Removed the key on ${prettyBone(names[0])} at frame ${frame}.`
    : `Removed ${names.length} key${names.length === 1 ? '' : 's'} at frame ${frame}.`);

  setFrame(state.frame);
  renderTracks();
  paintBoneTree();
  markDirty();
}

function markDirty() {
  state.clip.dirty = true;
  if (state.set.current) state.set.current.dirty = true;
  paintSaveState();
  renderAnims();
}

/* The two buttons that write things down, and what they have to say.
 *
 * They are deliberately different words for different places. "Save" writes
 * your clips into ~/Documents/gerak, which is your own filing and affects
 * nothing else. "Update the game" writes into the game's own asset, which
 * the game will be playing the next time you run it. Both show a dot when
 * there is something outstanding. */
function paintSaveState() {
  const edited = state.set ? state.set.edited().length : 0;
  const removed = state.set ? state.set.removed.length : 0;
  const save = $('#btn-save');
  save.textContent = edited ? `Save ${edited === 1 ? '' : edited + ' '}•` : 'Save';
  save.disabled = !state.model;

  const push = $('#btn-push');
  const pushable = !!(state.game && state.game.pushable);
  push.disabled = !pushable || !(edited || removed);
  push.textContent = state.game && state.game.here
    ? `Update ${state.game.here.game}` : 'Update the game';
  push.title = !state.model ? 'Open a character first'
    : !pushable ? 'Only a .glb can be updated in place — export this one first'
    : !(edited || removed) ? 'Nothing has been edited yet'
    : state.game.here
      ? `Put ${edited || 'no'} edited animation${edited === 1 ? '' : 's'} back into `
        + `${state.game.here.game}/${state.game.here.relative}`
      : 'Choose a game to send these animations to';
}

// ── the frame, and the timeline ─────────────────────────────────────

/* Reference pictures, floating over the viewport.
 *
 * It is handed the four things it needs and knows nothing else about gerak,
 * so it could be lifted into boneka for modelling reference without being
 * rewritten. */
const reference = new Reference({
  api,
  say: toast,
  clipName: () => state.clip.name || 'loose',
  onChange: () => { state.clip.reference = reference.toJSON(); state.clip.dirty = true; },
});

function setFrame(frame, fromPlayer = false) {
  state.frame = frame;
  // A 12-frame Muybridge walk against a 48-frame clip advances one reference
  // frame every four, so the two stay in step whatever length either is.
  reference.atFrame(frame, state.clip.frames);
  if (state.bones.length) {
    state.clip.applyTo(state.bones, view.restPose, frame);
    refreshChains();
  }
  if (!fromPlayer) player.frame = frame;

  const shown = Math.round(frame);
  const field = $('#frame-field');
  if (document.activeElement !== field) field.value = shown;
  movePlayhead(frame);
  if (!player.playing) { refreshRotationFields(); updateReadout(); paintClipboard(); }
}

const isPicked = (name, frame) =>
  state.picked.some((k) => k.name === name && k.f === frame);

function togglePicked(name, frame) {
  const at = state.picked.findIndex((k) => k.name === name && k.f === frame);
  if (at >= 0) state.picked.splice(at, 1);
  else state.picked.push({ name, f: frame });
}

function trackGeometry() {
  const area = $('#track-area');
  const pad = 118;                       // room for the joint name on the left
  const w = area.clientWidth - pad - 24;
  return { pad, w: Math.max(40, w), frames: Math.max(1, state.clip.frames) };
}

const frameToX = (f) => {
  const { pad, w, frames } = trackGeometry();
  return pad + (f / frames) * w;
};
const xToFrame = (x) => {
  const { pad, w, frames } = trackGeometry();
  return Math.max(0, Math.min(frames, Math.round(((x - pad) / w) * frames)));
};

function movePlayhead(frame) {
  $('#playhead').style.left = `${frameToX(frame)}px`;
}

function renderRuler() {
  const { frames } = trackGeometry();
  // Aim for a tick roughly every 70px, landing on a round number of frames.
  const approx = Math.max(1, Math.round(frames / Math.max(2, Math.floor(trackGeometry().w / 70))));
  const step = [1, 2, 5, 10, 12, 24, 25, 50, 100].find((s) => s >= approx) || approx;
  let html = '';
  for (let f = 0; f <= frames; f += step) {
    html += `<div class="tick" style="left:${frameToX(f)}px">${f}</div>`;
  }
  $('#ruler').innerHTML = html;
}

function renderTracks() {
  renderRuler();
  const container = $('#tracks');
  const sel = view.selected ? view.selected.name : null;

  // Show every keyed joint, in skeleton order, plus whatever is selected.
  const order = new Map(state.bones.map((b, i) => [b.name, i]));
  const names = state.clip.keyedNames().sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  if (sel && !names.includes(sel)) names.unshift(sel);

  if (!names.length) {
    container.innerHTML = `<p class="hint">No keys yet. Turn a joint and press <kbd>K</kbd>, or leave Auto-key on and just pose.</p>`;
    return;
  }

  container.innerHTML = names.map((name) => `
    <div class="track${name === sel ? ' is-on' : ''}" data-name="${escapeHTML(name)}">
      <span class="track-name">${escapeHTML(prettyBone(name))}</span>
      ${state.clip.keysOf(name).map((k) =>
        `<div class="keyd${isPicked(name, k.f) ? ' is-on' : ''}" style="left:${frameToX(k.f)}px" data-f="${k.f}"></div>`).join('')}
    </div>`).join('');

  container.querySelectorAll('.keyd').forEach((d) => {
    d.onclick = (e) => {
      e.stopPropagation();
      const name = d.closest('.track').dataset.name;
      const frame = +d.dataset.f;
      // Shift adds to what is picked out; a plain click starts again with
      // just this one, which is how every list on a Mac behaves.
      if (e.shiftKey) togglePicked(name, frame);
      else state.picked = [{ name, f: frame }];
      view.selectByName(name);
      setFrame(frame);
      renderTracks();
    };
  });
  container.querySelectorAll('.track').forEach((row) => {
    row.onclick = (e) => {
      state.picked = [];
      view.selectByName(row.dataset.name);
      setFrame(xToFrame(e.offsetX));
      renderTracks();
    };
  });
  movePlayhead(state.frame);
  paintClipboard();
}

// Scrubbing: press on the ruler and drag.
(() => {
  const ruler = $('#ruler');
  let scrubbing = false;
  const scrub = (e) => {
    const r = $('#track-area').getBoundingClientRect();
    setFrame(xToFrame(e.clientX - r.left));
  };
  ruler.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    player.pause();
    if (state.picked.length) { state.picked = []; renderTracks(); }
    ruler.setPointerCapture(e.pointerId);
    scrub(e);
  });
  ruler.addEventListener('pointermove', (e) => { if (scrubbing) scrub(e); });
  ruler.addEventListener('pointerup', (e) => {
    scrubbing = false;
    ruler.releasePointerCapture(e.pointerId);
  });
})();

// ── transport ───────────────────────────────────────────────────────

$('#tp-play').onclick = () => {
  if (!state.bones.length) return;
  player.loop = $('#chk-loop').checked;
  player.toggle(state.clip);
  $('#tp-play').textContent = player.playing ? '❚❚' : '▶';
};
$('#tp-start').onclick = () => setFrame(0);
$('#tp-end').onclick = () => setFrame(state.clip.frames);
$('#tp-prev').onclick = () => stepKey(-1);
$('#tp-next').onclick = () => stepKey(1);

function stepKey(dir) {
  const frames = view.selected && state.clip.tracks.has(view.selected.name)
    ? state.clip.keysOf(view.selected.name).map((k) => k.f)
    : state.clip.keyedFrames();
  const here = Math.round(state.frame);
  const next = dir > 0
    ? frames.find((f) => f > here)
    : [...frames].reverse().find((f) => f < here);
  if (next === undefined) { toast(dir > 0 ? 'No key after this one.' : 'No key before this one.'); return; }
  setFrame(next);
}

$('#frame-field').oninput = (e) => {
  const f = Math.max(0, Math.min(state.clip.frames, +e.target.value || 0));
  setFrame(f);
};
$('#length-field').onfocus = () => history.push('changing the clip length');
$('#length-field').oninput = (e) => {
  state.clip.frames = Math.max(1, +e.target.value || 48);
  markDirty();
  renderTracks();
};
$('#fps-field').onfocus = () => history.push('changing the frame rate');
$('#fps-field').oninput = (e) => {
  state.clip.fps = Math.max(1, Math.min(120, +e.target.value || 24));
  markDirty();
};
$('#chk-loop').onchange = (e) => { player.loop = e.target.checked; };

$('#btn-key').onclick = () => keyPose();
$('#btn-unkey').onclick = () => removeKeyHere();

$('#btn-reset-joint').onclick = () => {
  const bone = view.selected;
  if (!bone) return;
  const rest = view.restPose.get(bone.name);
  if (!rest) return;
  history.push(`resetting ${prettyBone(bone.name)}`);
  bone.quaternion.copy(rest.q);
  bone.position.copy(rest.p);
  if ($('#chk-autokey').checked) keyBone(bone, state.frame);
  refreshRotationFields();
  updateReadout();
  toast(`${prettyBone(bone.name)} is back to its rest pose.`);
};

/* Mirroring. Rigs put the two sides of a body at mirrored positions along X,
 * so flipping the sign of the Y and Z parts of a rotation is the right answer
 * for the great majority of them. It is a help, not a guarantee - look at the
 * result before you key it. */
$('#btn-mirror').onclick = () => {
  const bone = view.selected;
  if (!bone) return;
  const other = findMirror(bone.name, state.bones.map((b) => b.name));
  const target = other && state.bones.find((b) => b.name === other);
  if (!target) { toast(`No opposite joint found for ${prettyBone(bone.name)}.`, true); return; }
  history.push(`mirroring onto ${prettyBone(other)}`);
  const q = bone.quaternion;
  target.quaternion.set(q.x, -q.y, -q.z, q.w);
  if ($('#chk-autokey').checked) keyBone(target, state.frame);
  view.select(target);
  toast(`Mirrored onto ${prettyBone(other)} — check it before keying.`);
};

// ── saving and exporting ────────────────────────────────────────────

/* Save writes every animation you have edited into ~/Documents/gerak/clips,
 * not only the one on screen. Switching between a character's twelve
 * animations and then being asked to save them one at a time would put the
 * bookkeeping back on you, which is the thing the set was built to take
 * away.
 *
 * A clip is filed under the character and the animation together, so
 * "athlete_tall-smash" rather than "smash" — twelve of his characters have
 * an animation called run. */
$('#btn-save').onclick = async () => {
  state.set.stash(state.clip);
  const edited = state.set.edited();

  if (!edited.length) {
    toast(state.set.removed.length
      ? 'The merge is not saved here — press Update the game to apply it.'
      : 'Nothing to save yet — no edits.');
    return;
  }

  const base = state.model ? state.model.name.replace(/\.\w+$/, '') : 'clip';
  const saved = [];
  try {
    for (const entry of edited) {
      const doc = entry.clip.toJSON();
      doc.name = `${base}-${entry.name}`.replace(/^(.+)-\1$/, '$1');
      doc.anim = entry.name;
      doc.model = state.model ? state.model.path : doc.model;
      await api('/api/clip/save', doc);
      saved.push(entry.name);
    }
  } catch (err) {
    toast(`Could not save: ${err.message}`, true);
    return;
  }

  for (const entry of edited) { entry.dirty = false; entry.clip.dirty = false; }
  state.clip.dirty = false;
  paintSaveState();
  renderAnims();
  toast(saved.length === 1
    ? `Saved "${saved[0]}".`
    : `Saved ${saved.length} animations: ${saved.join(', ')}.`);
  loadClips();

  // Saving a clip means this model is something you are working on, so it
  // goes on bengkel's list. Merely opening a model does not.
  if (INSIDE_BENGKEL && state.model) {
    window.bengkel.note({
      path: state.model.path,
      name: state.model.name.replace(/\.\w+$/, ''),
      what: saved.length === 1 ? `saved the clip "${saved[0]}"`
                               : `saved ${saved.length} animations`,
    });
  }
};

/* ── Update the game ─────────────────────────────────────────────────
 *
 * The button he asked for: the animation he edited changes in the game too,
 * without an export, a copy and a drag into a folder.
 *
 * What it does is narrow on purpose. It writes the animations you edited
 * into the game's own .glb and takes out the ones you merged away, and it
 * touches nothing else in that file — not the mesh, not the skin, not the
 * materials, and not the animations you did not edit, which keep their
 * original curves down to the interpolation. A copy of the file as it was
 * goes into ~/Documents/gerak/backups first, every time.
 *
 * gerak's D-008 said the original file is never touched, and this is the
 * exception to it. It is the exception because he asked for it by name, and
 * because the alternative — export, find the file, copy it over the old one —
 * is the same write with more chances to put it in the wrong place.
 */
$('#btn-push').onclick = async () => {
  if (!state.model) return;
  player.pause();
  state.set.stash(state.clip);

  const { clips, remove } = state.set.push();
  if (!clips.length && !remove.length) { toast('Nothing has been edited yet.'); return; }

  const here = state.game && state.game.here;
  let game = '';

  if (!here) {
    // It came from somewhere that is not a game, so ask which game it is for.
    // That is a copy into the project rather than a write-back.
    const games = ((state.game && state.game.games) || []).filter((g) => g.godot);
    if (!games.length) { toast('No game project was found to send this to.', true); return; }
    game = await sheet({
      title: 'Which game is this for?',
      body: `<p><strong>${escapeHTML(state.model.name)}</strong> is not inside a game
             project, so gerak will put a copy into the one you choose and write
             the animations into that copy.</p>`,
      actions: [...games.map((g) => ({ id: g.game, label: g.game })),
                { id: null, label: 'Cancel' }],
    });
    if (!game) return;
  } else {
    const what = [
      clips.length && `${clips.length} edited animation${clips.length === 1 ? '' : 's'}`,
      remove.length && `${remove.length} deleted (${remove.join(', ')})`,
    ].filter(Boolean).join(', and ');
    const ok = await sheet({
      title: `Update ${here.game}?`,
      body: `<p>gerak will write ${what} into</p>
             <p><code>${escapeHTML(here.relative)}</code></p>
             <p>Everything else in that file is left exactly as it is, and a
             copy of it goes into <code>~/Documents/gerak/backups</code> first.</p>`,
      actions: [{ id: 'go', label: 'Update it', primary: true },
                { id: null, label: 'Cancel' }],
    });
    if (!ok) return;
  }

  const btn = $('#btn-push');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Writing…';

  try {
    const result = await api('/api/push', {
      model: state.model.path, clips, remove, game,
    });

    state.set.settled();
    state.clip.dirty = false;
    paintSaveState();
    renderAnims();

    const said = [];
    if (result.replaced.length) said.push(`replaced ${result.replaced.join(', ')}`);
    if (result.added.length) said.push(`added ${result.added.join(', ')}`);
    if (result.removed.length) said.push(`deleted ${result.removed.join(', ')}`);
    if (result.missing_joints.length) {
      toast(`These joints are not in the game's file, so they were skipped: `
            + result.missing_joints.join(', '), true);
    }
    /* gerak's timeline turns and moves a joint; it does not scale one. So an
     * animation that was squashing or stretching a bone in the original file
     * comes back without that part. Say so rather than let it be noticed in
     * the game — several of his Meshy characters animate scale. */
    if (result.lost_scale && result.lost_scale.length) {
      toast(`Note: ${result.lost_scale.join(', ')} had scaling in the original, `
            + 'which gerak does not animate — that part is gone. '
            + `The original is in ${result.shownBackup}.`, true);
    }
    toast(`${result.game || 'The game'}: ${said.join(', ')}. `
          + (result.godot ? 'Godot will re-import it when you next focus the editor.' : ''));
    console.log('[gerak] pushed', result);

    // The library row's animation count is now wrong, and so is the cached
    // scan behind it.
    loadLibrary(true);
  } catch (err) {
    toast(`Could not update the game: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
    paintSaveState();
  }
};

/* Export.
 *
 * The .glb is always written here in the browser, because that is the file
 * whose animation has been checked. Everything else - .fbx, .blend, a video -
 * is made from that same .glb by Blender, so there is only ever one path
 * from the timeline to a file, and three conversions off the end of it.
 */

$('#btn-export').onclick = () => {
  const pop = $('#export-pop');
  pop.hidden = !pop.hidden;
  if (!pop.hidden) $('#export-note').textContent = '';
};

// Click anywhere else and the panel goes away.
document.addEventListener('pointerdown', (e) => {
  const pop = $('#export-pop');
  if (pop.hidden) return;
  if (pop.contains(e.target) || $('#btn-export').contains(e.target)) return;
  pop.hidden = true;
});

async function buildGLB() {
  // Export from the rest pose. In a .glb the node transforms are the pose
  // the model sits in when nothing is playing, so leaving it mid-animation
  // would bake frame 37 in as the model's actual shape.
  const wasAt = state.frame;
  for (const bone of state.bones) {
    const rest = view.restPose.get(bone.name);
    if (rest) { bone.quaternion.copy(rest.q); bone.position.copy(rest.p); }
  }
  view.scene.updateMatrixWorld(true);

  const animation = state.clip.toAnimationClip(state.bones);
  const exporter = new GLTFExporter();
  const buffer = await new Promise((resolve, reject) => {
    exporter.parse(view.model, resolve, reject, {
      binary: true,
      animations: [animation],
      onlyVisible: false,
      includeCustomExtensions: false,
    });
  });

  setFrame(wasAt);
  return buffer;
}

$('#btn-export-go').onclick = async () => {
  if (state.clip.isEmpty()) { toast('Nothing to export yet — no keys.'); return; }
  player.pause();

  const extras = [
    $('#fmt-fbx').checked && 'fbx',
    $('#fmt-blend').checked && 'blend',
    $('#fmt-mp4').checked && 'mp4',
  ].filter(Boolean);

  const btn = $('#btn-export-go');
  const note = $('#export-note');
  note.classList.remove('is-bad');
  btn.disabled = true;
  const base = `${state.model.name.replace(/\.\w+$/, '')}-${state.clip.name}`
    .replace(/^(.+)-\1$/, '$1');

  try {
    note.textContent = 'Writing the .glb…';
    btn.textContent = 'Writing…';
    const saved = await api('/api/export/save', {
      name: base, ext: 'glb', data: toBase64(await buildGLB()),
    });

    const written = [`${saved.shown}  (${kb(saved.bytes)})`];

    if (extras.length) {
      note.textContent = extras.includes('mp4')
        ? 'Blender is rendering the video. This takes a moment.'
        : 'Blender is writing the other formats…';
      btn.textContent = 'Blender is working…';

      const result = await api('/api/convert', {
        path: saved.path,
        name: base,
        targets: extras,
        fps: state.clip.fps,
        spin: $('#fmt-spin').checked,
      });

      for (const item of result.written) written.push(`${item.shown}  (${kb(item.bytes)})`);
      if (result.problems && result.problems.length) {
        note.classList.add('is-bad');
        written.push('', ...result.problems);
      }
    }

    note.textContent = written.join('\n');
    toast(`Exported ${written.length} file${written.length === 1 ? '' : 's'} to exports/.`);
    api('/api/reveal', { path: saved.path }).catch(() => {});
  } catch (err) {
    console.error(err);
    note.classList.add('is-bad');
    note.textContent = `Export failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Write the files';
  }
};

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // In 32k slices: String.fromCharCode on a megabyte-long array blows the
  // argument limit and throws.
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}

// ── saved clips ─────────────────────────────────────────────────────

async function loadClips() {
  try {
    const { items } = await api(`/api/clips?t=${encodeURIComponent(TOKEN)}`);
    const list = $('#clip-list');
    if (!items.length) {
      list.innerHTML = '<p class="hint">No clips saved yet. Make one and press Save clip.</p>';
      return;
    }
    list.innerHTML = items.map((c, i) => `
      <button class="row" data-i="${i}">
        <div class="row-name">${escapeHTML(c.name)}</div>
        <div class="row-meta">${escapeHTML(c.modelName)}</div>
        <div class="row-tags">
          <span class="tag tag-rig">${c.keys} keys</span>
          <span class="tag">${c.frames} frames</span>
          <span class="tag">${c.fps} fps</span>
        </div>
      </button>`).join('');
    list.querySelectorAll('.row').forEach((row) => {
      row.onclick = () => openClip(items[+row.dataset.i]);
    });
  } catch { /* the panel just stays empty */ }
}

async function openClip(meta) {
  const doc = await api(`/api/clip?t=${encodeURIComponent(TOKEN)}&slug=${encodeURIComponent(meta.slug)}`);

  // Open the model the clip was made on, if it is not already open.
  if (!state.model || state.model.path !== doc.model) {
    const item = state.library.find((i) => i.path === doc.model);
    if (!item) { toast(`The model this clip was made on has moved: ${doc.model}`, true); return; }
    state.set = new AnimSet();   // so openModel does not ask about unsaved work
    await openModel(item);
  }

  history.push(`opening the clip "${meta.name}"`);
  state.clip = Clip.fromJSON(doc);
  reference.fromJSON(state.clip.reference);
  $('#fps-field').value = state.clip.fps;
  $('#length-field').value = state.clip.frames;

  /* A saved clip is a version of one of the character's animations, so it
   * goes back into the slot it came out of rather than floating beside the
   * set. `anim` is the name it has inside the file; clips saved before the
   * set existed do not carry one, and land in whichever slot is open. */
  const slot = doc.anim ? state.set.indexOf(doc.anim) : state.set.at;
  const entry = state.set.entries[slot >= 0 ? slot : state.set.at];
  if (entry) {
    state.set.at = state.set.entries.indexOf(entry);
    entry.clip = state.clip;
    entry.dirty = true;
    state.clip.name = entry.name;
  }

  setFrame(0);
  renderBoneTree();
  renderTracks();
  renderAnims();
  paintSaveState();
  toast(`Opened "${meta.name}" — ${state.clip.totalKeys()} keys.`);
}

// ── the rest of the chrome ──────────────────────────────────────────

function showTab(which) {
  const tab = document.querySelector(`.tab[data-tab="${which}"]`);
  if (tab) tab.click();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t === tab));
    document.querySelectorAll('.tab-body').forEach((b) =>
      b.classList.toggle('is-on', b.dataset.body === tab.dataset.tab));
    if (tab.dataset.tab === 'clips') loadClips();
    if (tab.dataset.tab === 'anims') renderAnims();
  };
});

$('#library-search').oninput = renderLibrary;
$('#only-rigged').onchange = renderLibrary;
$('#btn-rescan').onclick = () => loadLibrary(true);

document.querySelectorAll('[data-gizmo]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('[data-gizmo]').forEach((b) => b.classList.toggle('is-on', b === btn));
    view.setGizmoMode(btn.dataset.gizmo);
  };
});

const toggle = (el, fn) => {
  el.onclick = () => { el.classList.toggle('is-on'); fn(el.classList.contains('is-on')); };
};
toggle($('#toggle-skeleton'), (on) => view.setSkeletonVisible(on));
toggle($('#toggle-mesh'), (on) => view.setMeshVisible(on));
toggle($('#toggle-ground'), (on) => view.setGroundVisible(on));

window.addEventListener('resize', () => renderTracks());

/* Tell the rest of the page how tall the timeline actually is, so the
 * workspace leaves exactly that much room however the controls wrap. */
(() => {
  const timeline = $('#timeline');
  const measure = () => {
    document.documentElement.style.setProperty('--timeline-h', `${timeline.offsetHeight}px`);
    renderTracks();
  };
  new ResizeObserver(measure).observe(timeline);
  measure();
})();

// ── keyboard ────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const step = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case ' ': e.preventDefault(); $('#tp-play').click(); break;
    case 'z': case 'Z':
      if (!(e.metaKey || e.ctrlKey)) break;
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      break;
    case 'c': case 'C':
      if (!(e.metaKey || e.ctrlKey)) break;
      e.preventDefault();
      copyKeys();
      break;
    case 'v': case 'V':
      if (!(e.metaKey || e.ctrlKey)) break;
      e.preventDefault();
      pasteKeys({ flipped: e.shiftKey });
      break;
    case 'k': case 'K': keyPose(); break;
    case 'f': case 'F': $('#btn-reference').click(); break;
    case 'r': case 'R': document.querySelector('[data-gizmo="rotate"]').click(); break;
    case 'g': case 'G': document.querySelector('[data-gizmo="translate"]').click(); break;
    case 's': case 'S': $('#toggle-skeleton').click(); break;
    case 'm': case 'M': $('#toggle-mesh').click(); break;
    case 'ArrowRight': e.preventDefault(); setFrame(Math.min(state.clip.frames, Math.round(state.frame) + step)); break;
    case 'ArrowLeft': e.preventDefault(); setFrame(Math.max(0, Math.round(state.frame) - step)); break;
    case 'Delete': case 'Backspace': removeKeyHere(); break;
    case 'Escape': view.select(null); break;
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.clip.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ── next door ───────────────────────────────────────────────────────
 *
 * A model arriving from boneka opens like any other file; one going back is
 * exported first, because boneka reads files and not viewports.
 */

if (INSIDE_BENGKEL) {
  window.bengkel.onReceive(async (payload) => {
    if (!payload || !payload.path) return;
    const arrived = await openPath(payload.path);
    if (arrived) {
      toast(payload.note
        ? `"${payload.note}" came over from boneka — click a joint and start posing.`
        : 'Came over from boneka — click a joint and start posing.');
    }
  });

  const back = $('#btn-to-boneka');
  back.hidden = false;
  back.onclick = async () => {
    if (!state.model) { toast('Open a model first.'); return; }
    back.disabled = true;
    const was = back.textContent;
    back.textContent = 'Writing a .glb…';
    try {
      const base = `${state.model.name.replace(/\.\w+$/, '')}-${state.clip.name}`
        .replace(/^(.+)-\1$/, '$1');
      const saved = await api('/api/export/save', {
        name: base, ext: 'glb', data: toBase64(await buildGLB()),
      });
      await window.bengkel.handOver('boneka', saved.path, state.model.name);
      toast('Sent to boneka.');
    } catch (err) {
      toast(`Could not send it: ${err.message}`, true);
    } finally {
      back.textContent = was;
      back.disabled = false;
    }
  };
}

/* What bengkel's menu bar drives. Every tool it hosts answers to this one
 * name, so bengkel needs to know nothing about any of them. */
window.__toolCommand = (name) => command(name);

/* One handle on the whole app, for the tests that drive it in a real browser
 * and for poking at it from the browser console when something looks wrong. */
/* What the macOS menu bar drives.
 *
 * Every one of these is the same thing a click would do, so there is one
 * implementation of each action and the menu is only another way of reaching
 * it. Anything the menu cannot do, the page cannot do either. */
/* Typing in a box is typing in a box: Copy there should copy the text, not
 * the character's pose. Paste is left alone in a field because a browser will
 * not let a page paste on its own anyway. */
const typing = () => {
  const el = document.activeElement;
  return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

const COMMANDS = {
  undo,
  redo,
  copy: () => { if (typing()) document.execCommand('copy'); else copyKeys(); },
  paste: () => { if (!typing()) pasteKeys(); },
  pasteFlipped: () => { if (!typing()) pasteKeys({ flipped: true }); },
  save: () => $('#btn-save').click(),
  push: () => { if (!$('#btn-push').disabled) $('#btn-push').click(); },
  merge: () => { showTab('anims'); if (!$('#btn-merge').disabled) $('#btn-merge').click(); },
  animations: () => showTab('anims'),
  nextAnim: () => openAnim((state.set.at + 1) % Math.max(1, state.set.length)),
  prevAnim: () => openAnim((state.set.at - 1 + state.set.length) % Math.max(1, state.set.length)),
  export: () => { $('#export-pop').hidden = false; $('#btn-export-go').focus(); },
  exportNow: () => $('#btn-export-go').click(),
  key: () => keyPose(),
  unkey: () => removeKeyHere(),
  play: () => $('#tp-play').click(),
  start: () => setFrame(0),
  end: () => setFrame(state.clip.frames),
  nextKey: () => stepKey(1),
  prevKey: () => stepKey(-1),
  rotate: () => document.querySelector('[data-gizmo="rotate"]').click(),
  move: () => document.querySelector('[data-gizmo="translate"]').click(),
  skeleton: () => $('#toggle-skeleton').click(),
  mesh: () => $('#toggle-mesh').click(),
  floor: () => $('#toggle-ground').click(),
  reset: () => $('#btn-reset-joint').click(),
  mirror: () => $('#btn-mirror').click(),
  place: () => { if (!$('#rig-box').hidden) $('#btn-place').click(); },
  bind: () => { if (!$('#btn-bind').hidden) $('#btn-bind').click(); },
  rescan: () => loadLibrary(true),
  deselect: () => view.select(null),
};

function command(name) {
  const fn = COMMANDS[name];
  if (!fn) return false;
  fn();
  return true;
}

window.gerak = {
  state, view, player, api, command, openPath, native: NATIVE,
  history, undo, redo, copyKeys, pasteKeys, insideSanggar: INSIDE_BENGKEL,
  mirrorOf: (name, names) => findMirror(name, names),
  get clipboard() { return clipboard; },
  openModel, keyPose, setFrame, renderTracks, loadLibrary, reference,
  renderLimbs, setChainMode, togglePin, applyPins,
  placeSkeleton, showRigPanel, setFacing,
  openAnim, renderAnims, mergeAnims, sheet, showTab, whichGame,
};

// ── go ──────────────────────────────────────────────────────────────

/* Come back to the model you were working on.
 *
 * Only after the library has loaded, and only if the file is still there -
 * a model that has since been moved or deleted should leave you at the list,
 * not at an error. */
async function reopenLast() {
  const last = recall('gerak.lastModel');
  if (!last) return;
  const item = state.library.find((i) => i.path === last);
  if (item) { await openModel(item); return; }
  try {
    const found = await api(
      `/api/describe?t=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(last)}`);
    if (found && found.path) await openModel(found);
  } catch { /* it has moved or gone; leave the list showing */ }
}

paintHistory();
renderAnims();
recallClipboard();
paintClipboard();
loadLibrary().then(reopenLast);
loadClips();
renderRuler();

// If Blender is not where we expect it, say so on the export panel rather
// than letting the first export fail with a puzzle.
api(`/api/capabilities?t=${encodeURIComponent(TOKEN)}`).then((caps) => {
  if (caps.blender) return;
  for (const id of ['fmt-fbx', 'fmt-blend', 'fmt-mp4', 'fmt-spin']) {
    $(`#${id}`).disabled = true;
  }
  $('#export-note').textContent =
    `Blender was not found at ${caps.blenderPath}, so only .glb can be written. `
    + 'Set GERAK_BLENDER to where it is installed.';
}).catch(() => {});
