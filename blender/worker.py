"""
gerak's Blender worker.

A browser can write a .glb and nothing else. Blender can write everything
else, so anything gerak cannot do itself is handed over here:

    .fbx    for Unreal
    .blend  to finish the animation by hand
    .mp4    a rendered video of the clip

It is run headless, once per job, and told what to do by a JSON file:

    blender --background --factory-startup --python worker.py -- job.json

The job always starts from a .glb that gerak has already written and already
checked, so this file never has to understand keyframes. It imports, converts
and saves. Whatever it has to say comes back on stdout as one line starting
with @@GERAK@@, so the server can find it among Blender's own chatter.
"""

import json
import math
import os
import sys

import bpy
from mathutils import Vector


MARK = "@@GERAK@@"


def report(**payload):
    print(MARK + json.dumps(payload))
    sys.stdout.flush()


def read_job():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not args:
        raise SystemExit("no job file given")
    with open(args[0]) as f:
        return json.load(f)


# --------------------------------------------------------------------------
# the scene
# --------------------------------------------------------------------------

def fresh_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects]


def find_action():
    """The imported animation, if there is one, and the frames it covers."""
    for obj in bpy.data.objects:
        ad = obj.animation_data
        if ad and ad.action:
            act = ad.action
            lo, hi = 1e9, -1e9
            for fc in fcurves_of(act):
                for kp in fc.keyframe_points:
                    lo = min(lo, kp.co[0])
                    hi = max(hi, kp.co[0])
            if hi >= lo:
                return act, int(math.floor(lo)), int(math.ceil(hi))
            return act, 0, 0
    return None, 0, 0


def fcurves_of(action):
    """Blender 4.4 and later keep fcurves inside action layers, not on the
    action itself. Read whichever this build uses."""
    direct = getattr(action, "fcurves", None)
    if direct is not None and len(direct):
        return list(direct)
    out = []
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", []):
                out.extend(bag.fcurves)
    return out


def scene_bounds():
    """A box round every mesh in the scene, in world space."""
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    found = False
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        found = True
        for corner in obj.bound_box:
            p = obj.matrix_world @ Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    if not found:
        return Vector((-1, -1, 0)), Vector((1, 1, 2))
    return lo, hi


# --------------------------------------------------------------------------
# the jobs
# --------------------------------------------------------------------------

def write_fbx(path, fps):
    """FBX for Unreal.

    Leaf bones are left off because Unreal makes its own, and every rig that
    keeps them arrives with a spurious extra bone on the end of each chain.
    """
    bpy.context.scene.render.fps = fps
    bpy.ops.export_scene.fbx(
        filepath=path,
        use_selection=False,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_NONE",
        object_types={"ARMATURE", "MESH"},
        use_mesh_modifiers=False,
        add_leaf_bones=False,
        primary_bone_axis="Y",
        secondary_bone_axis="X",
        bake_anim=True,
        bake_anim_use_all_bones=True,
        bake_anim_use_nla_strips=False,
        bake_anim_use_all_actions=False,
        bake_anim_force_startend_keying=True,
        bake_anim_step=1.0,
        bake_anim_simplify_factor=0.0,
        path_mode="COPY",
        embed_textures=True,
    )


def write_blend(path):
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)


def render_video(path, fps, start, end, spin=False, size=(960, 540)):
    """A video of the clip, lit and framed well enough to send to somebody."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.fps = fps
    scene.frame_start = start
    scene.frame_end = max(end, start + 1)
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False

    # Blender 5 keeps video formats behind a media-type switch: until this
    # is set to VIDEO, FFMPEG is simply not in the list of formats.
    if hasattr(scene.render.image_settings, "media_type"):
        scene.render.image_settings.media_type = "VIDEO"
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    scene.render.ffmpeg.ffmpeg_preset = "GOOD"
    scene.render.filepath = path

    try:
        scene.eevee.taa_render_samples = 16
    except AttributeError:
        pass

    # A grey room, so nothing floats in a black void.
    world = bpy.data.worlds.new("gerak")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.055, 0.07, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    scene.world = world

    lo, hi = scene_bounds()
    centre = (lo + hi) / 2
    size3 = hi - lo
    span = max(size3.x, size3.y, size3.z) or 1.0

    # Floor, so the character has something to stand on and cast onto.
    bpy.ops.mesh.primitive_plane_add(size=span * 14, location=(centre.x, centre.y, lo.z))
    floor = bpy.context.object
    mat = bpy.data.materials.new("floor")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.09, 0.1, 0.12, 1)
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85
    floor.data.materials.append(mat)

    key = bpy.data.lights.new("key", type="AREA")
    key.energy = span * span * 900
    key.size = span * 2
    key_obj = bpy.data.objects.new("key", key)
    key_obj.location = centre + Vector((span * 1.6, -span * 1.9, span * 2.4))
    scene.collection.objects.link(key_obj)
    point_at(key_obj, centre)

    fill = bpy.data.lights.new("fill", type="AREA")
    fill.energy = span * span * 260
    fill.size = span * 3
    fill_obj = bpy.data.objects.new("fill", fill)
    fill_obj.location = centre + Vector((-span * 2.4, -span * 1.2, span * 1.2))
    scene.collection.objects.link(fill_obj)
    point_at(fill_obj, centre)

    cam_data = bpy.data.cameras.new("camera")
    cam_data.lens = 50
    cam = bpy.data.objects.new("camera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    distance = span * 2.6
    cam.location = centre + Vector((distance * 0.62, -distance * 0.86, span * 0.34))
    point_at(cam, centre)

    if spin:
        # One full turn over the length of the clip, about the model's centre.
        pivot = bpy.data.objects.new("pivot", None)
        pivot.location = centre
        scene.collection.objects.link(pivot)
        cam.parent = pivot
        cam.matrix_parent_inverse = pivot.matrix_world.inverted()
        pivot.rotation_euler = (0, 0, 0)
        pivot.keyframe_insert("rotation_euler", frame=scene.frame_start)
        pivot.rotation_euler = (0, 0, math.tau)
        pivot.keyframe_insert("rotation_euler", frame=scene.frame_end)
        for fc in fcurves_of(pivot.animation_data.action):
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"

    bpy.ops.render.render(animation=True)


def point_at(obj, target):
    """Aim an object's -Z axis at a point, which is how cameras and lights
    are oriented in Blender."""
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


# --------------------------------------------------------------------------

def main():
    job = read_job()
    source = job["source"]
    out_dir = job.get("out_dir") or os.path.dirname(source)
    name = job.get("name") or os.path.splitext(os.path.basename(source))[0]
    fps = int(job.get("fps") or 24)
    targets = job.get("targets") or []
    spin = bool(job.get("spin"))

    os.makedirs(out_dir, exist_ok=True)
    fresh_scene()
    import_glb(source)

    action, start, end = find_action()
    written = []
    problems = []

    for target in targets:
        path = os.path.join(out_dir, "%s.%s" % (name, target))
        try:
            if target == "fbx":
                write_fbx(path, fps)
            elif target == "blend":
                write_blend(path)
            elif target == "mp4":
                render_video(path, fps, start, end, spin=spin)
                # Blender appends the frame range to a video filename unless
                # the container is told otherwise; find whatever it wrote.
                if not os.path.exists(path):
                    stem = os.path.join(out_dir, name)
                    for candidate in sorted(os.listdir(out_dir)):
                        full = os.path.join(out_dir, candidate)
                        if full.startswith(stem) and candidate.endswith(".mp4"):
                            os.replace(full, path)
                            break
            else:
                problems.append("unknown format: %s" % target)
                continue
            written.append({
                "format": target,
                "path": path,
                "bytes": os.path.getsize(path) if os.path.exists(path) else 0,
            })
        except Exception as err:               # one bad format must not
            problems.append("%s: %s" % (target, err))   # sink the others

    report(
        ok=not problems,
        written=written,
        problems=problems,
        action=action.name if action else None,
        frames=[start, end],
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        report(ok=False, written=[], problems=["worker failed: %s" % err])
        raise
