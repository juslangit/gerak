#!/usr/bin/env python3
"""The .glb animation writer, checked against a real game character.

This is the test that matters most in gerak, because it is the only part of
the app that writes over a file Luqman did not make and cannot easily get
back. So it does not check that the function returned something sensible - it
reads the file back off the disk afterwards and proves, accessor by accessor,
that the mesh, the skin and the materials are the same bytes they were.

    python3 tests/glb.test.py
"""

import json
import os
import shutil
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import gltf_anim as ga                                       # noqa: E402

HOME = os.path.expanduser("~")
SUBJECT = os.environ.get("GERAK_TEST_GLB", os.path.join(
    HOME, "Desktop", "project", "game", "referee-for-fun",
    "assets", "characters", "athlete_tall.glb"))

PASS, FAIL = 0, 0


def check(ok, what):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  ok   %s" % what)
    else:
        FAIL += 1
        print("  FAIL %s" % what)


def section(title):
    print("\n── %s %s" % (title, "─" * max(0, 58 - len(title))))


# --------------------------------------------------------------------------

def read_accessor(doc, blob, i):
    """Pull one accessor out as a flat list of numbers, for comparing."""
    acc = doc["accessors"][i]
    if "bufferView" not in acc:
        return None
    view = doc["bufferViews"][acc["bufferView"]]
    sizes = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    kinds = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
             5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
    per = sizes[acc["type"]]
    code, width = kinds[acc["componentType"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    n = acc["count"] * per
    stride = view.get("byteStride")
    if stride and stride != per * width:
        out = []
        for k in range(acc["count"]):
            at = start + k * stride
            out += list(struct.unpack_from("<%d%s" % (per, code), blob, at))
        return out
    return list(struct.unpack_from("<%d%s" % (n, code), blob, start))


def fingerprint(doc, blob):
    """Everything about the file that this module promised not to change."""
    geometry = []
    for mesh in doc.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            for name, i in sorted((prim.get("attributes") or {}).items()):
                geometry.append((name, read_accessor(doc, blob, i)))
            if "indices" in prim:
                geometry.append(("indices", read_accessor(doc, blob, prim["indices"])))
    skins = [read_accessor(doc, blob, s["inverseBindMatrices"])
             for s in (doc.get("skins") or []) if "inverseBindMatrices" in s]
    return {
        "geometry": geometry,
        "skins": skins,
        "materials": json.dumps(doc.get("materials"), sort_keys=True),
        "textures": json.dumps(doc.get("textures"), sort_keys=True),
        "nodes": [(n.get("name"), n.get("translation"), n.get("rotation"),
                   n.get("scale"), n.get("children")) for n in doc.get("nodes") or []],
        "extensions": json.dumps(doc.get("extensionsUsed"), sort_keys=True),
    }


def a_clip(name, joints, frames=24, fps=24, travels=False):
    """A clip in the shape `Clip.toJSON()` hands over."""
    tracks = {}
    for n, joint in enumerate(joints):
        keys = []
        for f in range(0, frames + 1):
            t = f / frames
            keys.append({
                "f": f,
                "q": [0.0, 0.0, round(0.3 * t, 6), round((1 - 0.09 * t * t) ** 0.5, 6)],
                "p": [0.0, round(0.5 * t, 4) if travels else 0.0, 0.0],
            })
        tracks[joint] = keys
    return {"name": name, "fps": fps, "frames": frames, "tracks": tracks}


# --------------------------------------------------------------------------

def main():
    if not os.path.exists(SUBJECT):
        print("No model to test against at %s" % SUBJECT)
        print("Set GERAK_TEST_GLB to a .glb with animations in it.")
        return 1

    work = tempfile.mkdtemp(prefix="gerak-glb-")
    target = os.path.join(work, os.path.basename(SUBJECT))
    shutil.copy2(SUBJECT, target)
    backups = os.path.join(work, "backups")

    original_doc, original_blob = ga.read_glb(target)
    was = [a.get("name") for a in original_doc.get("animations") or []]
    print("subject: %s" % os.path.basename(SUBJECT))
    print("         %d animations, %d nodes, %d KB"
          % (len(was), len(original_doc["nodes"]), os.path.getsize(target) // 1024))
    before = fingerprint(original_doc, original_blob)

    joints = [n["name"] for n in original_doc["nodes"] if n.get("name")][:6]

    # ── names ──────────────────────────────────────────────────────────
    section("matching gerak's joint names to the file's")
    check(ga.sanitize("hand.L") == "handL", "a Blender name loses its dot")
    check(ga.sanitize("mixamorig:Hips") == "mixamorigHips", "a Mixamo name loses its colon")
    check(ga.sanitize("upper arm") == "upper_arm", "a space becomes an underscore")
    nodes = ga.node_indices(original_doc)
    hits = [j for j in joints if ga.sanitize(j) in nodes]
    check(len(hits) == len(joints), "every joint in the file is found by its sanitized name")

    # ── thinning ───────────────────────────────────────────────────────
    section("thinning the keys gerak sampled")
    still = [{"f": f, "q": [0, 0, 0, 1], "p": [0, 0, 0]} for f in range(25)]
    check(len(ga.thin(still)) == 2, "a joint that holds still keeps two keys, not twenty-five")

    ramp = [{"f": f, "q": ga._nlerp([0, 0, 0, 1], [0, 0, 0.3826, 0.9239], f / 24),
             "p": [0, 0, 0]} for f in range(25)]
    check(len(ga.thin(ramp)) <= 4, "an even turn keeps a handful of keys (%d)" % len(ga.thin(ramp)))

    bump = list(still)
    bump[12] = {"f": 12, "q": [0, 0, 0.3826, 0.9239], "p": [0, 0, 0]}
    kept = ga.thin(bump)
    check(any(k["f"] == 12 for k in kept), "the one frame that moves is never thinned away")

    moving = [{"f": f, "q": [0, 0, 0, 1], "p": [0, f * 0.01, 0]} for f in range(25)]
    check(len(ga.thin(moving)) == 2, "a joint travelling in a straight line keeps two keys")
    check(ga.thin(still)[-1]["f"] == 24, "the last frame always survives")

    # ── the push itself ────────────────────────────────────────────────
    section("pushing one edited animation into the file")
    doomed = was[-1]
    result = ga.push(target, [a_clip(was[0], joints)], remove=[doomed],
                     backup_into=backups)

    check(result["replaced"] == [was[0]], "the edited animation replaced the one of the same name")
    check(result["removed"] == [doomed], 'the merged-away "%s" was removed' % doomed)
    check(result["added"] == [], "nothing was added that was not asked for")
    check(os.path.exists(result["backup"]), "a backup of the original was written first")
    check(os.path.getsize(result["backup"]) == os.path.getsize(SUBJECT),
          "the backup is the whole original file")
    check(result["keys_after"] < result["keys_before"],
          "thinning shrank the keys (%d → %d)" % (result["keys_before"], result["keys_after"]))

    doc, blob = ga.read_glb(target)
    names = [a.get("name") for a in doc["animations"]]
    check(doomed not in names, "the removed animation is gone from the file on disk")
    check(names.count(was[0]) == 1, "the replaced animation appears exactly once")
    check(sorted(names) == sorted(n for n in was if n != doomed),
          "every other animation is still there, by name")

    # ── nothing else moved ─────────────────────────────────────────────
    section("everything the button promised not to touch")
    after = fingerprint(doc, blob)
    check(after["geometry"] == before["geometry"], "every vertex, normal, UV and index is unchanged")
    check(after["skins"] == before["skins"], "the skin's bind matrices are unchanged")
    check(after["materials"] == before["materials"], "the materials are unchanged")
    check(after["textures"] == before["textures"], "the textures are unchanged")
    check(after["nodes"] == before["nodes"], "the node tree and its rest pose are unchanged")
    check(after["extensions"] == before["extensions"], "the extensions it declares are unchanged")

    untouched = [a for a in doc["animations"] if a.get("name") == was[1]]
    old = [a for a in original_doc["animations"] if a.get("name") == was[1]][0]
    check(len(untouched) == 1 and
          len(untouched[0]["channels"]) == len(old["channels"]),
          "an animation nobody edited kept all %d of its channels" % len(old["channels"]))
    check(untouched[0]["samplers"][0]["interpolation"]
          == old["samplers"][0]["interpolation"],
          "...and its own interpolation, rather than being rewritten as LINEAR")
    check(read_accessor(doc, blob, untouched[0]["samplers"][0]["output"])
          == read_accessor(original_doc, original_blob, old["samplers"][0]["output"]),
          "...and its curve, number for number")

    # ── the animation that was written ─────────────────────────────────
    section("what the new animation says")
    fresh = [a for a in doc["animations"] if a.get("name") == was[0]][0]
    by_node = {}
    for ch in fresh["channels"]:
        by_node.setdefault(ch["target"]["node"], []).append(ch["target"]["path"])
    check(len(by_node) == len(joints), "one node per joint that was keyed")
    check(all("rotation" in p for p in by_node.values()), "every joint got a rotation track")
    check(all("translation" not in p for p in by_node.values()),
          "a joint that does not travel got no translation track")

    sampler = fresh["samplers"][0]
    times = read_accessor(doc, blob, sampler["input"])
    quats = read_accessor(doc, blob, sampler["output"])
    check(abs(times[0]) < 1e-6 and abs(times[-1] - 1.0) < 1e-6,
          "the animation runs from 0 to 1.0 seconds, as 24 frames at 24 fps should")
    check(abs(quats[3] - 1.0) < 1e-5, "the first key is the rest rotation that was keyed")
    check(abs(quats[-2] - 0.3) < 1e-5 and abs(quats[-1] - (1 - 0.09) ** 0.5) < 1e-5,
          "the last key holds the rotation that was keyed")
    stamps = doc["accessors"][sampler["input"]]
    check("min" in stamps and "max" in stamps, "the time accessor carries the min and max the spec demands")
    check(all(s["interpolation"] == "LINEAR" for s in fresh["samplers"]),
          "the new samplers are LINEAR, which is what gerak's timeline actually does")

    result = ga.push(target, [a_clip(was[1], joints, travels=True)])
    doc, blob = ga.read_glb(target)
    travelling = [a for a in doc["animations"] if a.get("name") == was[1]][0]
    paths = [c["target"]["path"] for c in travelling["channels"]]
    check("translation" in paths, "a joint that does travel gets a translation track")

    # ── the file does not grow without end ─────────────────────────────
    section("pushing the same thing ten times")
    sizes = []
    for _ in range(10):
        ga.push(target, [a_clip(was[0], joints)])
        sizes.append(os.path.getsize(target))
    check(len(set(sizes)) == 1,
          "the tenth push leaves the file exactly the size the first did (%d bytes)" % sizes[0])
    doc, blob = ga.read_glb(target)
    check(fingerprint(doc, blob)["geometry"] == before["geometry"],
          "the mesh survived eleven rewrites intact")
    check(doc["buffers"][0]["byteLength"] == len(blob),
          "the buffer's declared length matches the blob it describes")
    check(all(v.get("byteOffset", 0) + v["byteLength"] <= len(blob)
              for v in doc["bufferViews"]),
          "no buffer view points past the end of the blob")
    check(all(v.get("byteOffset", 0) % 4 == 0 for v in doc["bufferViews"]),
          "every buffer view is still four-byte aligned")

    # ── refusing what it should refuse ─────────────────────────────────
    section("what it refuses")
    for bad, why in [(b"not a glb at all", "a file that is not a .glb"),
                     (b"", "an empty file")]:
        junk = os.path.join(work, "junk.glb")
        with open(junk, "wb") as f:
            f.write(bad)
        try:
            ga.read_glb(junk)
            check(False, "refuses %s" % why)
        except ga.GlbError:
            check(True, "refuses %s" % why)

    try:
        ga.push(target, [a_clip("nope", ["no_such_joint_anywhere"])])
        check(False, "refuses a clip whose joints are not in the file")
    except ga.GlbError:
        check(True, "refuses a clip whose joints are not in the file")

    out = ga.push(target, [{"name": "partial", "fps": 24, "frames": 4,
                            "tracks": {joints[0]: a_clip("x", joints)["tracks"][joints[0]],
                                       "ghost_joint": a_clip("x", joints)["tracks"][joints[0]]}}])
    check(out["missing_joints"] == ["ghost_joint"],
          "a joint the file does not have is reported rather than swallowed")

    shutil.rmtree(work, ignore_errors=True)

    print("\n%d passed, %d failed" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
