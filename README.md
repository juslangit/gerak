# gerak

**An animation desk for the models already on this Mac.**

*gerak* means motion. You open a model, click a joint, turn it, and say
"the pose is this, here". Do that a few times along a timeline and you have an
animation. Export it and it goes into Godot, Unreal or Blender.

It runs entirely on this machine: the Python that comes with macOS, the Blender
already installed, and a copy of three.js kept in the folder. Nothing to
install, no account, no internet.

```bash
gerak
```

That starts it and opens the browser at `http://127.0.0.1:8778`.
Press `Ctrl-C` in the terminal to stop it.

---

## The idea in one paragraph

A rigged model is two things sharing one file: a **mesh**, which is the skin you
see, and a **skeleton**, which is a tree of bones hidden inside it. Every vertex
of the skin is tied to the bones near it. So you never move the skin — you turn
a bone, and the skin follows because it is attached. That is the whole trick,
and it is why all of gerak's work is turning bones.

## What you do with it

**Open a model.** The left panel lists every 3D model on this Mac, with the ones
that have a skeleton first. There are 312 of those, mostly Meshy characters.

**Click a joint.** Every bone gets an amber dot, drawn on top of the mesh so you
can reach a hip joint that is buried inside a body. Click one and a rotation
ring appears.

**Turn it.** Drag the ring, or type the angle in the right-hand panel. With
**Auto-key** on, letting go writes a key at whatever frame you are on.

**Move along the timeline and pose again.** A key is a moment you decided.
Frame 9 between keys at 6 and 12 is worked out on the spot, so you only pose
the moments that matter.

**Play it.** Space bar. Loop is on by default.

**Export it.** `.glb` with the animation baked in, written to `exports/` and
shown in Finder.

### If the model already has animations in it

Most Meshy characters arrive with a walk and a run inside them. gerak offers to
load one as ordinary keys, so you can edit someone else's walk instead of posing
one from a T-pose. It samples every frame rather than copying the curves, so
what you get is exactly what the file did.

## Keys on the keyboard

| Key | What it does |
|---|---|
| `K` | Key the pose at this frame |
| `Space` | Play / pause |
| `←` `→` | One frame back / forward (hold `Shift` for ten) |
| `R` / `G` | Rotate / move the selected joint |
| `S` / `M` | Show or hide the skeleton / the mesh |
| `Delete` | Remove the key under the playhead |
| `Esc` | Deselect |

## Where things are

```
server.py        finds your models, serves the page, keeps your clips
web/index.html   the page
web/style.css    the look
web/scene.js     the viewport — the model, the joint dots, the ring
web/clip.js      the animation maths — keys, in-betweens, export, playback
web/app.js       the wiring between those three
clips/           your saved animations, as plain readable JSON
exports/         the files gerak writes for you
tests/           see below
```

A clip is a small JSON file you can open and read. It names the model it was
made on and lists, per joint, the frames you keyed and the rotation at each.
Nothing in it is a secret format.

## Running the tests

```bash
gerak --no-open                       # start it, note the token it prints
GERAK_TOKEN=<the token> tests/run.sh
```

Three layers, in order of how much they prove:

1. **The animation maths**, in Node, no browser needed. Is frame 9 really
   between the keys at 6 and 12? Does a joint you never touched stay exactly
   where the model was built?
2. **The round trip**, in a real browser, on a real model off your disk. Read a
   `.glb`, pose it, write a new `.glb`, read that back — is the motion in there?
3. **The app**, driven like a person drives it: open a model, click a joint,
   turn it, key it, play it, export it.

The exported file has also been opened in Blender and checked: armature intact,
the action on the right bone, the clip the right length, the skin still bound.

## Why it locks itself

The server listens on localhost, and localhost is not a security boundary — any
web page you happen to have open in another tab can send requests to it. So
every request needs a token that is made fresh each time gerak starts, and must
come from gerak's own address. Models are only read from
`~/Desktop/project`, `~/Documents` and `~/Downloads`, and the path is resolved
before it is checked, so `..` and symlinks cannot walk out.

## Where this sits next to your other tools

- **boneka** *makes* models and rigs them, and animates by prompt.
  gerak *animates by hand*, and opens anything, not only boneka's output.
- **gudang** *judges and prepares* assets that arrive from elsewhere. Its own
  scope says characters, rigging and animation are not its job.

Nothing here overlaps either of them, which is deliberate.
