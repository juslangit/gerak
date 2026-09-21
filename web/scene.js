/* The viewport.
 *
 * This file owns everything you can see and click: the model, the dots on its
 * joints, the lines between them, and the ring you drag to turn a joint.
 *
 * The one idea worth knowing before reading it. A rigged model is two things
 * living in the same file - a mesh (the skin) and a skeleton (a tree of bones
 * inside it). You never touch the mesh. You turn a bone, and the mesh follows
 * because each vertex is weighted to nearby bones. So all of gerak's work is
 * setting bone rotations; the skin comes along by itself.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TransformControls } from 'three/addons/TransformControls.js';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';

export class Viewport {
  constructor(el) {
    this.el = el;
    this.bones = [];
    this.markers = [];
    this.handles = [];        // the draggable IK targets
    this.selected = null;
    this.selectedHandle = null;
    this.hovered = null;
    this.model = null;
    this.skinned = [];
    this.restPose = new Map();     // bone name -> { q, p } as it came out of the file
    this.sourceClips = [];         // animations that were already in the file
    this.onSelect = () => {};
    this.onJointChanged = () => {};
    this.onDragEnd = () => {};
    this.onHandleMoved = () => {};
    this.onHandleDropped = () => {};

    this._buildScene();
    this._buildPicking();
    this._loop();
  }

  // ── the fixed furniture: renderer, camera, lights, floor ──────────

  _buildScene() {
    const { clientWidth: w, clientHeight: h } = this.el;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x121419);

    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.01, 500);
    this.camera.position.set(2.4, 1.7, 3.4);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.075;
    this.orbit.target.set(0, 0.9, 0);

    const hemi = new THREE.HemisphereLight(0xdfe7ff, 0x2a2620, 1.35);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(3.2, 5.4, 2.8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.4;
    key.shadow.camera.far = 22;
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    key.shadow.bias = -0.0012;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9fb6ff, 0.55);
    fill.position.set(-4, 2.4, -3);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(12, 24, 0x3a4150, 0x23262e);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.scene.add(this.grid);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.ShadowMaterial({ opacity: 0.32 })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.scene.add(this.ground);

    // The ring you drag. In three r169 TransformControls is a controller and
    // its visible part comes from getHelper(), which is the thing that gets
    // added to the scene.
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setMode('rotate');
    this.gizmo.setSize(0.82);
    this.gizmo.setSpace('local');
    this.scene.add(this.gizmo.getHelper());

    // While a ring is being dragged the camera must hold still, or the model
    // spins away under your hand.
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) return;
      if (this.selectedHandle) this.onHandleDropped(this.selectedHandle.userData.chain);
      else if (this.selected) this.onDragEnd(this.selected);
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.selectedHandle) {
        this.onHandleMoved(this.selectedHandle.userData.chain,
          this.selectedHandle.position);
      } else if (this.selected) {
        this.onJointChanged(this.selected);
      }
    });

    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);

    this.jointGroup = new THREE.Group();
    this.scene.add(this.jointGroup);

    this.handleGroup = new THREE.Group();
    this.scene.add(this.handleGroup);

    // Joint dots and bone lines ignore depth on purpose, so a hip joint
    // buried inside a body is still visible and still clickable. A rigger
    // needs to reach the joint, not admire the skin covering it.
    this.matJoint = new THREE.MeshBasicMaterial({ color: 0xf5a524, depthTest: false });
    this.matHover = new THREE.MeshBasicMaterial({ color: 0xffd98a, depthTest: false });
    this.matSel   = new THREE.MeshBasicMaterial({ color: 0x4ea3f5, depthTest: false });
    this.matPinned = new THREE.MeshBasicMaterial({ color: 0x35c08a, depthTest: false });

    // An IK target is drawn as a diamond rather than a ball, so at a glance
    // you can tell "drag me somewhere" from "turn me".
    this.matHandle = new THREE.MeshBasicMaterial({ color: 0x35c08a, depthTest: false });
    this.matHandlePinned = new THREE.MeshBasicMaterial({ color: 0xef6461, depthTest: false });
    this.matHandleSel = new THREE.MeshBasicMaterial({ color: 0xa8f5d5, depthTest: false });

    this.boneLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x7c8598, depthTest: false, transparent: true, opacity: 0.85 })
    );
    this.boneLines.renderOrder = 998;
    this.boneLines.frustumCulled = false;
    this.scene.add(this.boneLines);

    window.addEventListener('resize', () => this.resize());
    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ── clicking a joint ──────────────────────────────────────────────

  _buildPicking() {
    this.ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downAt = null;

    const toPointer = (e) => {
      const r = this.renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      return pointer;
    };

    const hit = (e) => {
      this.ray.setFromCamera(toPointer(e), this.camera);
      // Handles first: an IK target sits right on top of the joint it drives,
      // and reaching for the target is the more likely intent.
      const onHandle = this.ray.intersectObjects(this.handles, false);
      if (onHandle.length) return { handle: onHandle[0].object };
      const onJoint = this.ray.intersectObjects(this.markers, false);
      return onJoint.length ? { bone: onJoint[0].object.userData.bone } : null;
    };

    this.renderer.domElement.addEventListener('pointermove', (e) => {
      if (this.gizmo.dragging) return;
      const found = hit(e);
      const bone = found && found.bone ? found.bone : null;
      if (bone !== this.hovered) {
        this.hovered = bone;
        this._paintMarkers();
      }
      this.renderer.domElement.style.cursor = found ? 'pointer' : '';
    });

    // A click selects; a drag is the camera orbiting, so remember where the
    // press started and ignore anything that travelled.
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      downAt = { x: e.clientX, y: e.clientY };
    });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 4 || this.gizmo.dragging) return;
      const found = hit(e);
      if (found && found.handle) this.selectHandle(found.handle);
      else if (found && found.bone) this.select(found.bone);
      else if (!this.gizmo.axis) this.select(null);
    });
  }

  select(bone) {
    this.selected = bone;
    this.selectedHandle = null;
    if (bone) {
      this.gizmo.setMode(this.boneMode || 'rotate');
      this.gizmo.attach(bone);
    } else {
      this.gizmo.detach();
    }
    this._paintMarkers();
    this.onSelect(bone);
  }

  /** Pick up an IK target. These are always dragged, never turned. */
  selectHandle(handle) {
    this.selected = null;
    this.selectedHandle = handle;
    this.gizmo.setMode('translate');
    this.gizmo.attach(handle);
    this._paintMarkers();
    this.onSelect(null);
  }

  // ── IK targets ────────────────────────────────────────────────────

  addHandle(chain) {
    const r = Math.max(this.modelSize * 0.026, 0.008);
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(r), this.matHandle);
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    mesh.userData.chain = chain;
    mesh.position.copy(chain.target);
    this.handleGroup.add(mesh);
    this.handles.push(mesh);
    chain.handle = mesh;
    return mesh;
  }

  removeHandle(chain) {
    const mesh = chain.handle;
    if (!mesh) return;
    if (this.selectedHandle === mesh) { this.selectedHandle = null; this.gizmo.detach(); }
    this.handleGroup.remove(mesh);
    mesh.geometry.dispose();
    this.handles = this.handles.filter((h) => h !== mesh);
    chain.handle = null;
  }

  clearHandles() {
    for (const mesh of this.handles.slice()) {
      if (mesh.userData.chain) this.removeHandle(mesh.userData.chain);
    }
  }

  /** Put every handle back on its chain's target, and colour the pinned ones. */
  syncHandles() {
    for (const mesh of this.handles) {
      const chain = mesh.userData.chain;
      if (this.selectedHandle !== mesh) mesh.position.copy(chain.target);
      mesh.material = this.selectedHandle === mesh ? this.matHandleSel
        : chain.pinned ? this.matHandlePinned
        : this.matHandle;
      mesh.scale.setScalar(this.selectedHandle === mesh ? 1.3 : 1);
    }
  }

  selectByName(name) {
    const bone = this.bones.find((b) => b.name === name);
    if (bone) this.select(bone);
  }

  setGizmoMode(mode) {
    this.boneMode = mode;
    if (!this.selectedHandle) this.gizmo.setMode(mode);
  }

  _paintMarkers() {
    for (const m of this.markers) {
      const b = m.userData.bone;
      m.material = b === this.selected ? this.matSel
        : b.userData.pinned ? this.matPinned
        : b === this.hovered ? this.matHover
        : this.matJoint;
      const s = b === this.selected ? 1.55 : b === this.hovered ? 1.28 : 1;
      m.scale.setScalar(s);
    }
  }

  // ── loading a model ───────────────────────────────────────────────

  async load(url) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    this.clear();

    this.model = gltf.scene;
    this.modelRoot.add(this.model);
    this.sourceClips = gltf.animations || [];

    this.skinned = [];
    this.model.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      if (o.isSkinnedMesh) this.skinned.push(o);
    });

    // Collect every bone once. A model can have several skinned meshes
    // sharing one skeleton, so de-duplicate by object identity.
    const seen = new Set();
    this.bones = [];
    for (const sm of this.skinned) {
      for (const b of sm.skeleton.bones) {
        if (!seen.has(b.uuid)) { seen.add(b.uuid); this.bones.push(b); }
      }
    }
    // Fall back to any Bone in the tree, for files whose skin is unusual.
    if (!this.bones.length) {
      this.model.traverse((o) => {
        if (o.isBone && !seen.has(o.uuid)) { seen.add(o.uuid); this.bones.push(o); }
      });
    }

    // Remember the pose the file arrived in. "Reset joint" and every frame
    // with no key on it come back to exactly this.
    this.restPose.clear();
    for (const b of this.bones) {
      this.restPose.set(b.name, {
        q: b.quaternion.clone(),
        p: b.position.clone(),
        s: b.scale.clone(),
      });
    }

    this._frameCamera();
    this._buildMarkers();

    return {
      bones: this.bones,
      roots: this.bones.filter((b) => !this.bones.includes(b.parent)),
      clips: this.sourceClips,
      meshes: this.skinned.length,
    };
  }

  clear() {
    this.gizmo.detach();
    this.selected = null;
    this.hovered = null;
    if (this.model) {
      this.modelRoot.remove(this.model);
      this.model.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          for (const m of [].concat(o.material)) {
            for (const k of Object.keys(m)) {
              if (m[k] && m[k].isTexture) m[k].dispose();
            }
            m.dispose();
          }
        }
      });
    }
    this.model = null;
    this.bones = [];
    this.skinned = [];
    this.sourceClips = [];
    for (const m of this.markers) this.jointGroup.remove(m);
    this.markers = [];
    this.clearHandles();
    if (this.draftRoot) { this.scene.remove(this.draftRoot); this.draftRoot = null; }
  }

  /** The model's box, in world space. */
  modelBox() {
    this.scene.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(this.model);
  }

  _frameCamera() {
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    this.modelSize = Math.max(size.x, size.y, size.z) || 1;

    // Stand it on the floor, so the grid means something.
    this.modelRoot.position.y = -box.min.y;
    centre.y += this.modelRoot.position.y;

    const dist = this.modelSize / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.camera.position.set(
      centre.x + dist * 0.78,
      centre.y + this.modelSize * 0.26,
      centre.z + dist * 1.22
    );
    this.orbit.target.copy(centre);
    this.camera.near = this.modelSize / 180;
    this.camera.far = this.modelSize * 90;
    this.camera.updateProjectionMatrix();
    this.orbit.update();

    const g = Math.max(4, Math.ceil(this.modelSize * 4));
    this.grid.scale.setScalar(g / 12);
    this.gizmo.setSize(Math.max(0.5, Math.min(1.4, this.modelSize * 0.55)));
  }

  _buildMarkers() {
    const r = Math.max(this.modelSize * 0.014, 0.004);
    const geo = new THREE.SphereGeometry(r, 12, 10);
    for (const bone of this.bones) {
      const m = new THREE.Mesh(geo, this.matJoint);
      m.renderOrder = 999;
      m.frustumCulled = false;
      m.userData.bone = bone;
      this.jointGroup.add(m);
      this.markers.push(m);
    }
    this.boneLines.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.bones.length * 6), 3)
    );
  }

  /* Markers are not parented to the bones. They are free-standing and copied
   * onto the bones' world positions every frame. That keeps their size
   * independent of whatever scale a bone happens to carry - a bone scaled to
   * 0.01 would otherwise take its dot down with it and leave nothing to click. */
  _syncMarkers() {
    if (!this.bones.length) return;
    const v = new THREE.Vector3();
    for (const m of this.markers) {
      m.position.setFromMatrixPosition(m.userData.bone.matrixWorld);
    }
    const attr = this.boneLines.geometry.getAttribute('position');
    let i = 0;
    for (const bone of this.bones) {
      if (bone.parent && bone.parent.isBone) {
        v.setFromMatrixPosition(bone.parent.matrixWorld);
        attr.setXYZ(i++, v.x, v.y, v.z);
        v.setFromMatrixPosition(bone.matrixWorld);
        attr.setXYZ(i++, v.x, v.y, v.z);
      }
    }
    for (; i < attr.count; i++) attr.setXYZ(i, 0, 0, 0);
    attr.needsUpdate = true;
    this.boneLines.geometry.setDrawRange(0, attr.count);
  }

  // ── a skeleton that does not exist yet ────────────────────────────

  /**
   * Put a draft skeleton into the scene.
   *
   * These are real three.js bones, parented to each other exactly as the
   * finished rig will be - they just have no skin attached yet. Making them
   * real bones means the joint dots, the tree, selection and the move gizmo
   * all work on them with no special cases, and dragging a shoulder carries
   * the arm below it, which is what you would expect.
   *
   * `placed` holds world positions; bones hold positions relative to their
   * parent, so each one is converted as it is hung on the tree.
   */
  buildDraft(placed) {
    this.clearDraft();
    // The limbs of whatever was open before are gone, so their handles must
    // go too, or a green diamond is left hanging in the air driving nothing.
    this.clearHandles();
    this.draftRoot = new THREE.Group();
    this.scene.add(this.draftRoot);

    const made = new Map();
    for (const p of placed) {
      const bone = new THREE.Bone();
      bone.name = p.name;
      made.set(p.name, bone);
    }
    for (const p of placed) {
      const bone = made.get(p.name);
      const parent = p.parent && made.get(p.parent);
      (parent || this.draftRoot).add(bone);
    }

    // Parents first, so a child's parent already sits where it belongs when
    // the child's local position is worked out from its world one.
    const order = [];
    const walk = (bone) => { order.push(bone); for (const c of bone.children) walk(c); };
    for (const child of this.draftRoot.children) walk(child);

    const byName = new Map(placed.map((p) => [p.name, p]));
    for (const bone of order) {
      const p = byName.get(bone.name);
      bone.parent.updateMatrixWorld(true);
      bone.position.copy(bone.parent.worldToLocal(new THREE.Vector3(...p.at)));
      bone.updateMatrixWorld(true);
    }

    this.draftRoot.updateMatrixWorld(true);
    this.bones = order;
    this.restPose.clear();
    for (const bone of this.bones) {
      this.restPose.set(bone.name, {
        q: bone.quaternion.clone(), p: bone.position.clone(), s: bone.scale.clone(),
      });
    }

    for (const m of this.markers) this.jointGroup.remove(m);
    this.markers = [];
    this._buildMarkers();
    this.select(null);
    this.setGizmoMode('translate');
    return this.bones;
  }

  clearDraft() {
    if (!this.draftRoot) return;
    this.scene.remove(this.draftRoot);
    this.draftRoot = null;
    for (const m of this.markers) this.jointGroup.remove(m);
    this.markers = [];
    this.bones = [];
    this.select(null);
  }

  get hasDraft() { return !!this.draftRoot; }

  /** Where every draft joint sits, in the model's own coordinates. */
  draftJoints() {
    this.scene.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    return this.bones.map((bone) => {
      bone.getWorldPosition(world);
      // The model is stood on the floor for display, so a joint's world
      // position is not its position in the file. Put it back into the
      // model's own space before it is sent anywhere.
      const local = this.model.worldToLocal(world.clone());
      return {
        name: bone.name,
        parent: bone.parent && bone.parent.isBone ? bone.parent.name : null,
        at: local.toArray(),
      };
    });
  }

  setSkeletonVisible(on) { this.jointGroup.visible = on; this.boneLines.visible = on; }
  setMeshVisible(on) { if (this.model) this.model.visible = on; }
  setGroundVisible(on) { this.ground.visible = on; this.grid.visible = on; }

  // ── the frame loop ────────────────────────────────────────────────

  _loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      this.orbit.update();
      this.scene.updateMatrixWorld(true);
      this._syncMarkers();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }
}
