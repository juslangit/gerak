"""Write animations into a .glb, and leave everything else in it alone.

This is what stands behind the "Update the game" button. The file it writes
into is a real game asset, so the rule here is narrow on purpose: **only the
animations array, and the buffer bytes the animations own, may change.** The
mesh, the skin, the materials, the textures and the node tree come out the
other side byte for byte as they went in.

Why not hand it to Blender, which gerak already uses for .fbx and video? A
Blender round trip re-exports the whole file. Materials are rebuilt from
Blender's own node graph, vertex order can move, and extensions the file
carried are gone. For a file that is about to sit back down in a Godot
project, that is a great deal of collateral change for the sake of replacing
one animation. Editing the glTF JSON directly touches nothing it was not
asked to.

A .glb is a 12-byte header and then a run of chunks: the glTF JSON, and one
binary blob that every accessor in the file indexes into. So the work is:

  1. parse the JSON and the blob
  2. drop the animations being replaced or merged away
  3. build new ones out of gerak's keys, appending their numbers to the blob
  4. throw away the accessors and buffer views nothing points at any more,
     and repack the blob so the file does not grow with every push

Step 4 is what stops the file doubling in size after ten pushes. It is
skipped, deliberately, when the file uses an extension that could be holding
a buffer view reference this module does not know how to follow - better a
file with some dead bytes in it than a file with a dangling index.
"""

import json
import math
import os
import re
import shutil
import struct
import time

MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942

FLOAT = 5126
SCALAR, VEC3, VEC4 = "SCALAR", "VEC3", "VEC4"

# Extensions that cannot be hiding a buffer view or accessor reference from
# the garbage collector below. Anything outside this list turns the collector
# off rather than risk breaking an index it cannot see - the compressed-mesh
# extensions (KHR_draco_mesh_compression, EXT_meshopt_compression) are the
# ones that would really bite.
GC_SAFE = {
    "KHR_materials_specular", "KHR_materials_emissive_strength",
    "KHR_materials_unlit", "KHR_materials_clearcoat", "KHR_materials_ior",
    "KHR_materials_sheen", "KHR_materials_transmission",
    "KHR_materials_volume", "KHR_materials_iridescence",
    "KHR_materials_anisotropy", "KHR_materials_pbrSpecularGlossiness",
    "KHR_texture_transform", "KHR_texture_basisu", "KHR_lights_punctual",
    "KHR_mesh_quantization", "KHR_materials_variants",
}


class GlbError(Exception):
    """The file is not one this module is willing to edit."""


# --------------------------------------------------------------------------
# reading and writing the container
# --------------------------------------------------------------------------

def read_glb(path):
    """Hand back the glTF document and the binary blob beside it."""
    with open(path, "rb") as f:
        raw = f.read()

    if len(raw) < 12:
        raise GlbError("that file is too short to be a .glb")
    magic, version, length = struct.unpack("<III", raw[:12])
    if magic != MAGIC:
        raise GlbError("that is not a .glb - a .gltf with its buffers in "
                       "separate files cannot be edited in place")
    if version != 2:
        raise GlbError("only glTF 2 is understood, and that file says %d" % version)

    doc, blob, at = None, b"", 12
    while at + 8 <= min(length, len(raw)):
        size, kind = struct.unpack("<II", raw[at:at + 8])
        body = raw[at + 8:at + 8 + size]
        if kind == JSON_CHUNK:
            doc = json.loads(body.decode("utf-8"))
        elif kind == BIN_CHUNK:
            blob = body
        at += 8 + size + (-size % 4)

    if doc is None:
        raise GlbError("that .glb has no glTF chunk in it")
    return doc, blob


def write_glb(path, doc, blob):
    """Write the file out, whole, in one go."""
    text = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)                 # spaces, says the spec
    body = blob + b"\0" * (-len(blob) % 4)          # zeroes, says the spec

    parts = [struct.pack("<II", len(text), JSON_CHUNK), text]
    if body:
        parts += [struct.pack("<II", len(body), BIN_CHUNK), body]
    payload = b"".join(parts)

    with open(path, "wb") as f:
        f.write(struct.pack("<III", MAGIC, 2, 12 + len(payload)))
        f.write(payload)


def back_up(path, into):
    """Copy the file aside before it is written over, and say where it went.

    gerak's D-008 was that an original is never touched. This button is the
    exception he asked for, so the promise becomes a weaker but still real
    one: there is always a copy of what the file said a moment ago.
    """
    os.makedirs(into, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d-%H%M%S")
    base = os.path.basename(path)
    stem, ext = os.path.splitext(base)
    out = os.path.join(into, "%s-%s%s" % (stem, stamp, ext))
    shutil.copy2(path, out)
    return out


# --------------------------------------------------------------------------
# joints: matching gerak's names to the file's nodes
# --------------------------------------------------------------------------

_SPACE = re.compile(r"\s")
_RESERVED = re.compile(r"[\[\]./:]")


def sanitize(name):
    """The name three.js will be calling this node by.

    three.js cannot put a `.` or a `:` in a track name - it uses them to
    separate the object from the property - so its glTF loader strips them
    from every node name on the way in. A Blender rig's `hand.L` is `handL`
    by the time gerak has it, and `mixamorig:Hips` is `mixamorigHips`. Match
    the file's names through the same sieve or nothing lines up.
    """
    return _RESERVED.sub("", _SPACE.sub("_", name or ""))


def node_indices(doc):
    """Map every name gerak could be using to the node it means.

    A name that is not unique after sanitizing is left out rather than
    guessed at: three.js makes those unique by hanging a number on the end,
    and picking the wrong one of two joints would animate the wrong limb.
    """
    seen = {}
    for i, node in enumerate(doc.get("nodes") or []):
        for key in {node.get("name") or "", sanitize(node.get("name"))}:
            if not key:
                continue
            seen.setdefault(key, []).append(i)
    return {k: v[0] for k, v in seen.items() if len(v) == 1}


# --------------------------------------------------------------------------
# thinning: gerak samples every frame, a game file need not carry that
# --------------------------------------------------------------------------

def _qdot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _nlerp(a, b, t):
    """Interpolate two quaternions the way glTF's LINEAR sampler does."""
    if _qdot(a, b) < 0:
        b = [-x for x in b]
    out = [a[i] + (b[i] - a[i]) * t for i in range(4)]
    n = math.sqrt(sum(x * x for x in out)) or 1.0
    return [x / n for x in out]


def _angle_between(a, b):
    d = min(1.0, abs(_qdot(a, b)))
    return 2.0 * math.acos(d)


def thin(keys, angle_tol=0.002, pos_tol=1e-4):
    """Drop the keys a straight line between their neighbours already covers.

    gerak reads an animation out of a file by sampling it at every frame, on
    purpose - it copies what the file did rather than the curves that did it
    (see `Clip.fromAnimationClip`). That is the right thing on the way in and
    the wrong thing on the way out: a joint that holds still for a second
    should not go back into a game asset as twenty-four identical keys.

    So this walks the track and keeps only the keys that a linear sampler
    could not have worked out for itself. The tolerances are deliberately
    tighter than anyone can see - about a ninth of a degree, and a tenth of a
    millimetre - so this shrinks the file without changing the motion.
    """
    if len(keys) <= 2:
        return list(keys)

    out = [keys[0]]
    anchor = 0
    at = 1
    while at < len(keys) - 1:
        # Could every key between the anchor and at+1 be guessed from the two
        # ends? If so the anchor can reach further and they all go.
        a, b = keys[anchor], keys[at + 1]
        span = b["f"] - a["f"]
        ok = span > 0
        if ok:
            for k in keys[anchor + 1:at + 2]:
                t = (k["f"] - a["f"]) / span
                if _angle_between(_nlerp(a["q"], b["q"], t), k["q"]) > angle_tol:
                    ok = False
                    break
                if any(abs(a["p"][i] + (b["p"][i] - a["p"][i]) * t - k["p"][i]) > pos_tol
                       for i in range(3)):
                    ok = False
                    break
        if ok:
            at += 1
        else:
            out.append(keys[at])
            anchor = at
            at += 1

    out.append(keys[-1])
    return out


# --------------------------------------------------------------------------
# building the animations
# --------------------------------------------------------------------------

class _Blob:
    """Somewhere to put numbers, handing back the buffer view that holds them."""

    def __init__(self, doc, blob):
        self.doc = doc
        self.parts = [blob]
        self.at = len(blob)

    def add(self, payload):
        pad = -self.at % 4          # every accessor in here is 4-byte floats
        if pad:
            self.parts.append(b"\0" * pad)
            self.at += pad
        offset = self.at
        self.parts.append(payload)
        self.at += len(payload)

        views = self.doc.setdefault("bufferViews", [])
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(payload)})
        return len(views) - 1

    def accessor(self, payload, count, kind, minmax=None):
        acc = {"bufferView": self.add(payload), "componentType": FLOAT,
               "count": count, "type": kind}
        if minmax:
            acc["min"], acc["max"] = minmax
        self.doc.setdefault("accessors", []).append(acc)
        return len(self.doc["accessors"]) - 1

    def finish(self):
        return b"".join(self.parts)


def _floats(values):
    return struct.pack("<%df" % len(values), *values)


def _moves(keys, tol=1e-6):
    """True when the joint actually travels, rather than just turning.

    The same rule the browser export uses: a joint that keeps the offset the
    rig was built with does not need a translation track, and leaving it out
    keeps the file smaller and easier for an engine to retarget.
    """
    first = keys[0]["p"]
    return any(abs(k["p"][i] - first[i]) > tol for k in keys for i in range(3))


def build_animation(clip, nodes, blob, thinning=True):
    """Turn one of gerak's clips into a glTF animation.

    `clip` is what `Clip.toJSON()` produces: a name, an fps, a length in
    frames, and for each joint a list of `{f, q, p}`.
    """
    fps = float(clip.get("fps") or 24)
    frames = int(clip.get("frames") or 0)
    samplers, channels = [], []
    missing, before, after = [], 0, 0

    for name, raw in sorted((clip.get("tracks") or {}).items()):
        if not raw:
            continue
        node = nodes.get(name)
        if node is None:
            node = nodes.get(sanitize(name))
        if node is None:
            missing.append(name)
            continue

        keys = sorted(raw, key=lambda k: k["f"])

        # A glTF animation is exactly as long as its last key, so a 48-frame
        # clip whose last pose was keyed at frame 36 would arrive in the game
        # as a 36-frame animation and every loop would be wrong. The timeline
        # holds that pose out to the end, so write the hold down as a key.
        if frames and keys[-1]["f"] < frames:
            last = keys[-1]
            keys = keys + [{"f": frames, "q": list(last["q"]), "p": list(last["p"])}]

        before += len(keys)
        if thinning:
            keys = thin(keys)
        after += len(keys)

        times = [k["f"] / fps for k in keys]
        stamps = blob.accessor(_floats(times), len(times), SCALAR,
                               ([times[0]], [times[-1]]))

        rot = blob.accessor(
            _floats([v for k in keys for v in k["q"]]), len(keys), VEC4)
        samplers.append({"input": stamps, "output": rot, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1,
                         "target": {"node": node, "path": "rotation"}})

        if _moves(keys):
            pos = blob.accessor(
                _floats([v for k in keys for v in k["p"]]), len(keys), VEC3)
            samplers.append({"input": stamps, "output": pos,
                             "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1,
                             "target": {"node": node, "path": "translation"}})

    if not channels:
        raise GlbError('"%s" has nothing in it that matches a joint in the '
                       "file" % clip.get("name", "that clip"))

    animation = {"name": clip.get("name") or "clip",
                 "samplers": samplers, "channels": channels}
    return animation, {"missing": missing, "keys_before": before,
                       "keys_after": after, "joints": len(channels)}


# --------------------------------------------------------------------------
# taking out what nothing points at any more
# --------------------------------------------------------------------------

def _gc_safe(doc):
    used = set(doc.get("extensionsUsed") or [])
    if used - GC_SAFE:
        return False
    buffers = doc.get("buffers") or []
    return len(buffers) == 1 and not buffers[0].get("uri")


def repack(doc, blob):
    """Throw away the unreferenced accessors and buffer views, and rebuild
    the blob out of what is left.

    Replacing an animation orphans the accessors the old one owned. Left
    there they are only dead weight, but they are dead weight that grows by
    the size of an animation every single push - so a file pushed to twenty
    times would be mostly the animations it no longer has.
    """
    if not _gc_safe(doc):
        return blob, {"collected": False}

    accessors = doc.get("accessors") or []
    views = doc.get("bufferViews") or []

    live_acc, live_view = set(), set()

    def want_acc(i):
        if isinstance(i, int) and 0 <= i < len(accessors):
            live_acc.add(i)

    def want_view(i):
        if isinstance(i, int) and 0 <= i < len(views):
            live_view.add(i)

    for mesh in doc.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            for i in (prim.get("attributes") or {}).values():
                want_acc(i)
            want_acc(prim.get("indices"))
            for target in prim.get("targets") or []:
                for i in target.values():
                    want_acc(i)
    for skin in doc.get("skins") or []:
        want_acc(skin.get("inverseBindMatrices"))
    for anim in doc.get("animations") or []:
        for sampler in anim.get("samplers") or []:
            want_acc(sampler.get("input"))
            want_acc(sampler.get("output"))
    for image in doc.get("images") or []:
        want_view(image.get("bufferView"))

    for i in sorted(live_acc):
        acc = accessors[i]
        want_view(acc.get("bufferView"))
        sparse = acc.get("sparse") or {}
        want_view((sparse.get("indices") or {}).get("bufferView"))
        want_view((sparse.get("values") or {}).get("bufferView"))

    keep_acc = sorted(live_acc)
    keep_view = sorted(live_view)
    acc_map = {old: new for new, old in enumerate(keep_acc)}
    view_map = {old: new for new, old in enumerate(keep_view)}

    parts, at = [], 0
    new_views = []
    for old in keep_view:
        view = dict(views[old])
        start = view.get("byteOffset", 0)
        length = view["byteLength"]
        pad = -at % 4
        if pad:
            parts.append(b"\0" * pad)
            at += pad
        view["byteOffset"] = at
        parts.append(blob[start:start + length])
        at += length
        new_views.append(view)

    new_acc = []
    for old in keep_acc:
        acc = dict(accessors[old])
        if "bufferView" in acc:
            acc["bufferView"] = view_map[acc["bufferView"]]
        if "sparse" in acc:
            sparse = json.loads(json.dumps(acc["sparse"]))
            for side in ("indices", "values"):
                if side in sparse and "bufferView" in sparse[side]:
                    sparse[side]["bufferView"] = view_map[sparse[side]["bufferView"]]
            acc["sparse"] = sparse
        new_acc.append(acc)

    # ...and now every index that named an accessor or a view has moved.
    for mesh in doc.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            prim["attributes"] = {k: acc_map[v]
                                  for k, v in (prim.get("attributes") or {}).items()}
            if "indices" in prim:
                prim["indices"] = acc_map[prim["indices"]]
            if prim.get("targets"):
                prim["targets"] = [{k: acc_map[v] for k, v in t.items()}
                                   for t in prim["targets"]]
    for skin in doc.get("skins") or []:
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = acc_map[skin["inverseBindMatrices"]]
    for anim in doc.get("animations") or []:
        for sampler in anim.get("samplers") or []:
            sampler["input"] = acc_map[sampler["input"]]
            sampler["output"] = acc_map[sampler["output"]]
    for image in doc.get("images") or []:
        if "bufferView" in image:
            image["bufferView"] = view_map[image["bufferView"]]

    doc["accessors"] = new_acc
    doc["bufferViews"] = new_views
    out = b"".join(parts)
    doc["buffers"] = [{"byteLength": len(out)}]

    return out, {"collected": True,
                 "dropped_accessors": len(accessors) - len(new_acc),
                 "dropped_views": len(views) - len(new_views)}


# --------------------------------------------------------------------------
# the whole job
# --------------------------------------------------------------------------

def push(path, clips, remove=(), thinning=True, backup_into=None):
    """Put `clips` into the .glb at `path`, and take `remove` out of it.

    An animation whose name matches one being written is replaced; a name in
    `remove` is deleted; everything else in the file is left exactly as it
    was, curves included. That last part matters: only the animations you
    actually edited are rewritten, so the rest keep whatever the original
    file said, down to their STEP interpolation and their spline tangents.
    """
    doc, blob = read_glb(path)
    if doc.get("asset", {}).get("version", "2.0").split(".")[0] != "2":
        raise GlbError("that file is not glTF 2")

    nodes = node_indices(doc)
    if not nodes:
        raise GlbError("that file has no named nodes to animate")

    was = [a.get("name") or "" for a in (doc.get("animations") or [])]
    incoming = [c.get("name") or "clip" for c in clips]
    gone = {n for n in remove if n} | set(incoming)

    # An animation being replaced may have been scaling a bone as well as
    # turning and moving it. gerak's timeline has no scale on it - a joint
    # keeps the size the rig was built with - so a replaced animation comes
    # back without whatever scaling it had. That is a real change to the
    # file, so it is named in the result rather than left to be noticed.
    scaled = sorted({(a.get("name") or "") for a in (doc.get("animations") or [])
                     if (a.get("name") or "") in set(incoming)
                     and any(c.get("target", {}).get("path") == "scale"
                             for c in a.get("channels") or [])})

    kept = [a for a in (doc.get("animations") or []) if (a.get("name") or "") not in gone]
    # The names of what is being left alone, taken now: `kept` is the same
    # list the new animations are about to be appended to.
    left_alone = [a.get("name") or "" for a in kept]
    doc["animations"] = kept

    blobber = _Blob(doc, blob)
    written, notes = [], []
    for clip in clips:
        animation, note = build_animation(clip, nodes, blobber, thinning)
        doc["animations"].append(animation)
        written.append(animation["name"])
        notes.append(note)

    blob = blobber.finish()
    doc["buffers"] = [{"byteLength": len(blob)}]
    blob, gc = repack(doc, blob)

    saved = back_up(path, backup_into) if backup_into else None
    before = os.path.getsize(path)
    write_glb(path, doc, blob)

    return {
        "ok": True,
        "path": path,
        "backup": saved,
        "replaced": [n for n in written if n in was],
        "added": [n for n in written if n not in was],
        "removed": sorted(n for n in remove if n and n in was),
        "left_alone": left_alone,
        "lost_scale": scaled,
        "animations": [a.get("name") or "" for a in doc["animations"]],
        "missing_joints": sorted({m for n in notes for m in n["missing"]}),
        "keys_before": sum(n["keys_before"] for n in notes),
        "keys_after": sum(n["keys_after"] for n in notes),
        "bytes_before": before,
        "bytes_after": os.path.getsize(path),
        "collected": gc.get("collected", False),
    }
