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
import { detectLimbs, chainFrom } from '/web/ik.js';
import { TEMPLATES, TEMPLATE_ORDER, fitTemplate, guessFacing, headsAndTails }
  from '/web/templates.js';

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
  model: null,          // the library row that is open
  bones: [],
  frame: 0,
  chains: [],           // the limbs, each either FK or IK
  rig: { template: 'biped', facing: 0, flip: false },
};

const view = new Viewport($('#viewport'));
const player = new Player((f) => setFrame(f, true));

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

function renderLibrary() {
  const q = $('#library-search').value.trim().toLowerCase();
  const onlyRigged = $('#only-rigged').checked;
  const list = $('#library-list');

  let items = state.library;
  if (onlyRigged) items = items.filter((i) => i.rigged);
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
  if (state.clip.dirty && !confirm('This clip has unsaved changes. Open another model anyway?')) return;

  toast(`Opening ${item.name}…`);
  player.pause();

  try {
    const info = await view.load(modelURL(item.path));
    state.model = item;
    state.bones = info.bones;
    state.chains = [];
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

    state.chains = boneless ? [] : detectLimbs(state.bones);
    renderBoneTree();
    renderLimbs();
    setFrame(0);
    renderTracks();
    offerSourceClips(info.clips);

    remember('gerak.lastModel', item.path);
    document.title = `${item.name} — gerak`;
    toast(`${item.name} is open — click a joint to start.`);
  } catch (err) {
    console.error(err);
    toast(`Could not open ${item.name}: ${err.message}`, true);
  }
  renderLibrary();
}

/* A Meshy model often arrives with a walk and a run already inside it. Rather
 * than ignore them, offer to turn one into editable keys - it is far quicker
 * to fix someone else's walk than to pose one from a T-pose. */
function offerSourceClips(clips) {
  if (!clips.length) return;
  const names = clips.map((c) => c.name);
  const pick = names.length === 1 ? names[0] : null;
  const msg = pick
    ? `This file already contains "${pick}". Load it as editable keys?`
    : `This file contains ${names.length} animations. Load one as editable keys?\n\n` +
      names.map((n, i) => `${i + 1}. ${n}`).join('\n') +
      `\n\nType a number, or cancel.`;

  setTimeout(() => {
    let chosen = null;
    if (pick) { if (confirm(msg)) chosen = clips[0]; }
    else {
      const answer = prompt(msg, '1');
      const i = parseInt(answer, 10) - 1;
      if (i >= 0 && i < clips.length) chosen = clips[i];
    }
    if (!chosen) return;
    importSourceClip(chosen);
  }, 400);
}

function importSourceClip(source) {
  const fps = +$('#fps-field').value || 24;
  const imported = Clip.fromAnimationClip(source, state.bones, view.restPose, fps);
  imported.model = state.model.path;
  imported.name = `${state.model.name.replace(/\.\w+$/, '')}-${source.name}`;
  state.clip = imported;
  $('#length-field').value = imported.frames;
  setFrame(0);
  renderBoneTree();
  renderTracks();
  toast(`Loaded "${source.name}" — ${imported.totalKeys()} keys on ${imported.tracks.size} joints. Edit any of them.`);
}

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
  let n = 0;
  for (const bone of state.bones) {
    const rest = view.restPose.get(bone.name);
    const moved = !rest ||
      Math.abs(bone.quaternion.dot(rest.q)) < 0.999999 ||
      bone.position.distanceToSquared(rest.p) > 1e-12;
    // Already-keyed joints are re-keyed too, so a pose is stored whole and
    // does not half-change when you scrub back to it.
    if (moved || state.clip.tracks.has(bone.name)) {
      state.clip.setKey(bone.name, frame, bone.quaternion, bone.position);
      n++;
    }
  }
  if (!n) { toast('Nothing has moved yet — turn a joint first.'); return; }
  renderTracks();
  paintBoneTree();
  markDirty();
  toast(`Keyed ${n} joint${n === 1 ? '' : 's'} at frame ${Math.round(frame)}.`);
}

function removeKeyHere() {
  const bone = view.selected;
  const frame = Math.round(state.frame);
  if (bone) {
    if (state.clip.removeKey(bone.name, frame)) {
      toast(`Removed the key on ${prettyBone(bone.name)} at frame ${frame}.`);
    } else {
      toast('No key on that joint at this frame.');
    }
  } else {
    let n = 0;
    for (const name of state.clip.keyedNames()) if (state.clip.removeKey(name, frame)) n++;
    toast(n ? `Removed ${n} key${n === 1 ? '' : 's'} at frame ${frame}.` : 'No keys at this frame.');
  }
  setFrame(state.frame);
  renderTracks();
  paintBoneTree();
  markDirty();
}

function markDirty() {
  state.clip.dirty = true;
  $('#btn-save').textContent = 'Save clip •';
}

// ── the frame, and the timeline ─────────────────────────────────────

function setFrame(frame, fromPlayer = false) {
  state.frame = frame;
  if (state.bones.length) {
    state.clip.applyTo(state.bones, view.restPose, frame);
    refreshChains();
  }
  if (!fromPlayer) player.frame = frame;

  const shown = Math.round(frame);
  const field = $('#frame-field');
  if (document.activeElement !== field) field.value = shown;
  movePlayhead(frame);
  if (!player.playing) { refreshRotationFields(); updateReadout(); }
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
        `<div class="keyd" style="left:${frameToX(k.f)}px" data-f="${k.f}"></div>`).join('')}
    </div>`).join('');

  container.querySelectorAll('.keyd').forEach((d) => {
    d.onclick = (e) => {
      e.stopPropagation();
      view.selectByName(d.closest('.track').dataset.name);
      setFrame(+d.dataset.f);
    };
  });
  container.querySelectorAll('.track').forEach((row) => {
    row.onclick = (e) => {
      view.selectByName(row.dataset.name);
      setFrame(xToFrame(e.offsetX + (e.target === row ? 0 : 0)));
    };
  });
  movePlayhead(state.frame);
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
$('#length-field').oninput = (e) => {
  state.clip.frames = Math.max(1, +e.target.value || 48);
  markDirty();
  renderTracks();
};
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
  const other = mirrorName(bone.name);
  const target = state.bones.find((b) => b.name === other);
  if (!target) { toast(`No opposite joint found for ${prettyBone(bone.name)}.`, true); return; }
  const q = bone.quaternion;
  target.quaternion.set(q.x, -q.y, -q.z, q.w);
  if ($('#chk-autokey').checked) keyBone(target, state.frame);
  view.select(target);
  toast(`Mirrored onto ${prettyBone(other)} — check it before keying.`);
};

function mirrorName(name) {
  const swaps = [
    [/(^|[^a-z])Left/i, '$1Right'], [/(^|[^a-z])Right/i, '$1Left'],
    [/_L$/, '_R'], [/_R$/, '_L'],
    [/\.L$/, '.R'], [/\.R$/, '.L'],
    [/_l$/, '_r'], [/_r$/, '_l'],
  ];
  for (const [from, to] of swaps) if (from.test(name)) return name.replace(from, to);
  return name;
}

// ── saving and exporting ────────────────────────────────────────────

$('#btn-save').onclick = async () => {
  if (state.clip.isEmpty()) { toast('Nothing to save yet — no keys.'); return; }
  const name = prompt('Name this clip', state.clip.name);
  if (!name) return;
  state.clip.name = name;
  try {
    await api('/api/clip/save', state.clip.toJSON());
    state.clip.dirty = false;
    $('#btn-save').textContent = 'Save clip';
    toast(`Saved "${name}".`);
    loadClips();
  } catch (err) {
    toast(`Could not save: ${err.message}`, true);
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
    state.clip = new Clip();     // so openModel does not ask about unsaved work
    await openModel(item);
  }

  state.clip = Clip.fromJSON(doc);
  $('#fps-field').value = state.clip.fps;
  $('#length-field').value = state.clip.frames;
  $('#btn-save').textContent = 'Save clip';
  setFrame(0);
  renderBoneTree();
  renderTracks();
  toast(`Opened "${state.clip.name}" — ${state.clip.totalKeys()} keys.`);
}

// ── the rest of the chrome ──────────────────────────────────────────

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t === tab));
    document.querySelectorAll('.tab-body').forEach((b) =>
      b.classList.toggle('is-on', b.dataset.body === tab.dataset.tab));
    if (tab.dataset.tab === 'clips') loadClips();
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

// ── keyboard ────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const step = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case ' ': e.preventDefault(); $('#tp-play').click(); break;
    case 'k': case 'K': keyPose(); break;
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

/* One handle on the whole app, for the tests that drive it in a real browser
 * and for poking at it from the browser console when something looks wrong. */
/* What the macOS menu bar drives.
 *
 * Every one of these is the same thing a click would do, so there is one
 * implementation of each action and the menu is only another way of reaching
 * it. Anything the menu cannot do, the page cannot do either. */
const COMMANDS = {
  save: () => $('#btn-save').click(),
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
  openModel, keyPose, setFrame, renderTracks, loadLibrary,
  renderLimbs, setChainMode, togglePin, applyPins,
  placeSkeleton, showRigPanel, setFacing,
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
