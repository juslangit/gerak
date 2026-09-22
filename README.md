# gerak

**An animation desk for the models already on this Mac.**

*gerak* means motion. You open a model, click a joint, turn it, and say
"the pose is this, here". Do that a few times along a timeline and you have an
animation. Export it and it goes into Godot, Unreal, Blender or a video.

If the model has no skeleton, you give it one: drop a ready-made skeleton on
it — human, four-legged animal, bird, fish, snake — nudge the joints where
they belong, and Blender works out which part of the skin each bone moves.

It runs entirely on this machine: the Python that comes with macOS, the Blender
already installed, and a copy of three.js kept in the folder. Nothing to
install, no account, no internet.

## Three ways to run it

**Inside sanggar**, which is the front door to all of it — `sanggar.app` holds
gerak and boneka in one window, and a model made in boneka opens here with one
click. Everything below still works exactly as it did.

## And on its own

**As a Mac app.** `gerak.app` in `/Applications` — double-click it, or find it
in Spotlight. Its own window, its own menu bar, a Dock icon. It starts and
stops its own server; there is no terminal involved. Drop a `.glb` on the
window, or open one with it from Finder.

```bash
native/build.sh --install        # build it and put it in /Applications
native/build.sh --run            # ...and open it
```

**In a browser**, which is the same thing without the wrapper, and where the
log is in front of you:

```bash
gerak
```

That starts it and opens the browser at `http://127.0.0.1:8778`.
Press `Ctrl-C` in the terminal to stop it.

Your clips and exports go to **`~/Documents/gerak/`** either way.

---

## The idea in one paragraph

A rigged model is two things sharing one file: a **mesh**, which is the skin you
see, and a **skeleton**, which is a tree of bones hidden inside it. Every vertex
of the skin is tied to the bones near it. So you never move the skin — you turn
a bone, and the skin follows because it is attached. That is the whole trick,
and it is why all of gerak's work is turning bones.

## What you do with it

**Open a model.** The left panel lists every 3D model on this Mac, with the ones
that have a skeleton first. There are 312 of those, mostly Meshy characters —
and 3,100 more with no skeleton, which you can now give one.

**Click a joint.** Every bone gets an amber dot, drawn on top of the mesh so you
can reach a hip joint that is buried inside a body. Click one and a rotation
ring appears.

**Turn it.** Drag the ring, or type the angle in the right-hand panel. With
**Auto-key** on, letting go writes a key at whatever frame you are on.

**Move along the timeline and pose again.** A key is a moment you decided.
Frame 9 between keys at 6 and 12 is worked out on the spot, so you only pose
the moments that matter.

**Copy a pose and paste it somewhere else.** `⌘C` takes the pose at the
playhead; `⌘V` puts it down at whatever frame you are on. `⇧⌘V` puts it down
with left and right swapped, which is how the second half of a walk cycle gets
made. Click a key on the timeline to pick just that one out, shift-click to
pick more, and Copy takes only those.

**Change your mind.** The two arrows beside the Key buttons are undo and
redo, and `⌘Z` does the same. Hover one and it names what it will undo —
"Undo turning LeftArm", "Undo keying frame 12".

**Play it.** Space bar. Loop is on by default.

**Know which way round you are.** The floor is a proper grid — fine squares
with a brighter line every tenth, a red line down X and a blue one down Z,
fading out with distance. In the top right is the axis widget: click any ball
to swing the camera flat onto that axis without changing how far away it is.

**Turn IK on for an arm or a leg.** Each limb has an **FK / IK** switch in the
Limbs panel. On FK you turn the joints one at a time. On IK you get a green
diamond to drag, and the shoulder and elbow are worked out to put the hand
there. Pin a foot and it stays planted while you move the body.

**Export it.** `.glb` for Godot, `.fbx` for Unreal, `.blend` to finish by
hand, and an `.mp4` of the clip playing. Everything lands in `exports/` and
opens in Finder.

### Giving a model a skeleton

Open something with no skeleton and a rigging panel appears instead of the
limbs panel.

1. **Pick a skeleton** — human, four-legged animal, bird, fish, or a plain
   chain for a snake, rope or tail.
2. **Say which way it faces.** Nothing agrees about which way is forwards, so
   there is a Front / Right / Back / Left switch. For a long animal gerak
   guesses from the shape of the model; for a person it does not guess,
   because a person is very nearly as deep as they are wide.
3. **Place it.** The skeleton is fitted into the model's own bounding box, so
   the same template fits a chess piece and a two-metre character. Drag any
   joint onto the right part of the model — the joints below it come along.
4. **Bind.** Blender weights the skin to the bones and hands back a rigged
   copy, which opens straight away, ready to pose. **Your original file is
   never touched** — the rigged copy goes in `exports/`.

If some of the mesh was too far from every bone to be claimed, gerak says how
many vertices that was. Those parts will not move; put a joint nearer and bind
again.

### If the model already has animations in it

Most Meshy characters arrive with a walk and a run inside them. gerak offers to
load one as ordinary keys, so you can edit someone else's walk instead of posing
one from a T-pose. It samples every frame rather than copying the curves, so
what you get is exactly what the file did.

## Reference pictures

Animating from memory is how a walk comes out looking like somebody wading.
The question is never *what does a walking person look like* — it is **where
is the far leg on frame six**.

Press **Reference** in the viewport tools, or **F**, and search.

### Motion studies

Eadweard Muybridge photographed people and animals frame by frame in the 1880s
to settle what a galloping horse really does with its legs. Walking, running,
jumping, climbing, boxing, dancing; horses, dogs, cats, elephants, buffalo. The
plates are long out of copyright, Wikimedia Commons holds them, and a great
many are already assembled into animated GIFs.

A GIF is a sequence already, so nothing has to be guessed about where one
frame ends. Those results are marked **sequence**, and when you pin one:

- it is **pulled apart into frames** on the way in;
- **Follow** steps it with your timeline, *proportionally* — a 12-frame
  Muybridge walk against a 48-frame clip advances one reference frame every
  four, so the two stay in step whatever length either is;
- **Flip** plays the reference on its own at about twelve a second, which is
  roughly what Muybridge shot at, for comparing timing rather than poses.

They are anatomical studies, so the human ones are nude figures — that is the
point of them, and it is what a search for "walking" returns. **Photographs**
is the other tab when you want somebody with clothes on, or something
Muybridge never shot.

### The pinned picture

One picture floats over the viewport. Drag its title bar to move it, its
bottom-right corner to resize it, and the slider to fade it — so you pose the
leg against the photograph rather than against your memory of it. It goes to
full strength while the pointer is over it, so a faint reference can still be
read when you reach for its controls.

You can also **drop a picture of your own** on the drawer.

### It stays with the clip

A pinned reference is saved in the clip, with where it came from and its
licence, and comes back when you reopen it. The picture itself is copied to
`~/Documents/gerak/references/<clip>/` — a reference that lives at a URL is a
reference that is gone when the link rots or the laptop is on a train.

Nothing is fetched by the page: the server gets the picture and hands it over,
so Commons never learns what you are animating.

## Keys on the keyboard

| Key | What it does |
|---|---|
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| `⌘C` / `⌘V` | Copy the pose / paste it here |
| `⇧⌘V` | Paste it with left and right swapped |
| `K` | Key the pose at this frame |
| `Space` | Play / pause |
| `←` `→` | One frame back / forward (hold `Shift` for ten) |
| `R` / `G` | Rotate / move the selected joint |
| `S` / `M` | Show or hide the skeleton / the mesh |
| `F` | Reference pictures |
| `Delete` | Remove the key under the playhead |
| `Esc` | Deselect |

In the app the menu bar has all of these as well, with the usual Mac
shortcuts: `⌘O` to open a model, `⌘S` to save a clip, `⌘E` to export, `⌘K` to
key the pose, `⌘B` to bind a skin.

## Where things are

```
server.py          finds your models, serves the page, runs Blender
blender/worker.py  the jobs Blender does: rigging, .fbx, .blend, video
native/            the macOS app — one Swift file and a build script
tools/shot.mjs     takes the pictures in screenshots/
web/index.html     the page
web/style.css      the look
web/scene.js       the viewport — the model, the joint dots, the ring
web/clip.js        the animation maths — keys, in-betweens, export, playback
web/ik.js          the IK solver, and finding the limbs on a skeleton
web/templates.js   the ready-made skeletons, and fitting one to a model
web/app.js         the wiring between all of those
tests/             see below
```

Your own work lives outside the code, in `~/Documents/gerak/`:

```
clips/             your saved animations, as plain readable JSON
exports/           the files gerak writes for you
```

A clip is a small JSON file you can open and read. It names the model it was
made on and lists, per joint, the frames you keyed and the rotation at each.
Nothing in it is a secret format.

## Running the tests

```bash
gerak --no-open                       # start it, note the token it prints
GERAK_TOKEN=<the token> tests/run.sh
```

Six suites, in order of how much each one proves:

1. **The animation maths**, in Node, no browser needed. Is frame 9 really
   between the keys at 6 and 12? Does a joint you never touched stay exactly
   where the model was built?
2. **The IK solver.** Does the hand land where you put it — including when the
   target is out of reach, sitting on top of the shoulder, or the limb is
   already dead straight?
3. **The round trip**, in a real browser, on a real model off your disk. Read a
   `.glb`, pose it, write a new `.glb`, read that back — is the motion in there?
4. **Rigging**, on a human and on a dog. Does a joint placed at the left
   shoulder end up at the left shoulder after Blender has had it? Three
   coordinate conventions meet there and a mistake looks plausible in a
   thumbnail, so it is measured rather than eyeballed.
5. **The app**, driven like a person drives it: open a model, click a joint,
   turn it, key it, play it, drag an IK handle, pin a foot, export all four
   formats.
6. **The rigging flow**, end to end: a model with no skeleton becomes a rigged,
   posed, keyed, IK-driven animation without anybody touching Blender.

And the app has its own suite, which checks only what becoming an application
added — the things that break at that boundary:

```bash
tests/native.sh
```

It builds the app, checks the bundle is the shape macOS expects, starts it,
watches the server come up on a port the system chose, drives the menu bar
into the page, force-quits the app to make sure the server does not outlive
it, and has Finder hand it a `.glb` the way double-clicking one does.

The exported files have also been opened in Blender and checked by hand:
armature intact, the action on the right bone, the clip the right length, the
skin still bound — and a frame of the rendered video looked at with eyes.

## Why it locks itself

The server listens on localhost, and localhost is not a security boundary — any
web page you happen to have open in another tab can send requests to it. So
every request needs a token that is made fresh each time gerak starts, and must
come from gerak's own address. Models are only read from
`~/Desktop/project`, `~/Documents` and `~/Downloads`, and the path is resolved
before it is checked, so `..` and symlinks cannot walk out.

## Where this sits next to your other tools

- **sanggar** is the window all of this now lives in. Inside it, gerak's
  library pins boneka's models first, a model handed over from boneka opens
  straight away, and the export panel can send an animated one back. Outside
  it, none of that exists and gerak is unchanged.
- **boneka** *makes* models and rigs them, and animates by prompt.
  gerak *animates by hand*, and opens anything on the Mac, not only boneka's
  output. boneka's decision D-005 deliberately left IK out; gerak is where it
  lives.
- **gudang** *judges and prepares* assets that arrive from elsewhere. Its own
  scope says characters, rigging and animation are not its job.

Nothing here overlaps either of them, which is deliberate.

## What Blender is used for, and what it is not

gerak does the interactive half itself, in the browser, because a round trip
to Blender on every drag would make posing unusable. Blender is called only
for work that happens once, on a button press:

| Job | Where | Why there |
|---|---|---|
| Posing, IK, the timeline, playback | browser | has to be instant |
| Writing the `.glb` | browser | three.js already holds the scene |
| Weighting a skin to new bones | Blender | nothing else does heat weighting |
| `.fbx`, `.blend`, video | Blender | a browser cannot write them |

Blender runs headless, one process per job, and is told what to do by a JSON
file. If it is installed somewhere else, set `GERAK_BLENDER` to the path —
gerak checks on startup and says so on the export panel if it cannot find it.

## The app, and what it adds

The engine is the same: the app loads gerak's own page in a `WKWebView` and
runs the same Python server, so every test above still applies. What the
wrapper adds is everything that makes a program an application.

| | |
|---|---|
| **Its own window** | Transparent title bar with the page's top bar drawn under it, so there is no second strip of chrome. Comes back the size and place you left it. |
| **A menu bar** | Every action the page can do, in the place macOS puts it, with the shortcuts it expects. |
| **Native dialogs** | A `WKWebView` shows *nothing at all* for `alert`, `confirm` and `prompt` unless told how, so gerak's prompts became real Mac sheets. |
| **Drop a file on it** | JavaScript is given a dropped file's contents but never its path, and gerak works in paths — so the drop is caught in AppKit, where the path still exists. |
| **Open from Finder** | Registered for `.glb` and `.gltf` as an *alternate* handler: it offers itself in Open With without taking the file type over. |
| **Remembers** | The window, and the model you had open. |
| **Starts and stops its server** | On a port the system picks, so the app and a browser gerak can both be open. And the server watches its parent — if the app is force-quit or crashes, the server lets itself out rather than sitting on a port forever. |

There is no Xcode project. `swiftc` comes with the command line tools, and an
app bundle is a folder with an `Info.plist` in it, so `native/build.sh`
assembles one in about ten seconds. It is signed ad-hoc, which is all an app
that never leaves this machine needs.

The log is at `~/Library/Logs/gerak.log`, and the app's own menu has a
**Show the log** item.

## The floor, and which way is up

The grid is not made of lines. It is one flat surface with a shader that
works out, per pixel, how close that pixel is to a grid line and how wide a
line should look from where the camera is standing — which is why it stays
one pixel thick however far you zoom in, and dissolves into the distance
instead of turning into a shimmering moiré. It picks its own spacing from the
size of the model, so a chess piece and a two-metre character both get a
sensible number of squares under them.

The axis widget in the corner turns with the view and snaps the camera to an
axis when you click a ball. **It says Y at the top where Blender says Z**, and
that is deliberate: gerak's world is Y-up, like glTF and like Godot, because
that is what the files it opens and writes actually contain. Blender is Z-up
and converts on the way in and out. The widget names the axes the model really
has rather than the ones Blender would call them — otherwise moving a joint
"up the Z axis" would move it the wrong way.

## What undo remembers

Undo works by photographing the state before each action rather than by
teaching every action how to reverse itself. The second way is cheaper and is
wrong the first time somebody adds an action and forgets the reverse; this way
is duller and much harder to get wrong. A clip is a few hundred numbers and a
pose is one rotation per joint, so a photograph is cheap. Forty of them are
kept, and a new model starts a new stack.

Each photograph holds **the clip, the pose the joints are actually in, and —
while a skeleton is being placed — where its joints sit.** The pose is in
there as well as the clip because you can turn a joint without keying it, and
that is exactly the pose you are most likely to want back.

It does not remember the camera, what is selected in the list, or which panels
are open. Undo should put the work back, not the furniture.

Steps are only recorded when something really changes, so pressing Delete on a
frame with no keys does not leave a step you then have to undo past.

## Copying a pose

Copy takes one of two things depending on what you have picked out on the
timeline:

- **nothing picked** — the whole pose at the playhead, *sampled*, so a frame
  with no key on it still copies. That is what "copy the pose" has to mean,
  or copying would only work on frames that already had keys.
- **keys picked** — exactly those keys, keeping the gaps between them. Paste
  anchors the earliest one at the playhead and everything else keeps its
  distance.

What gets stored is **joint names and rotations, not frame numbers**, so a
pose copied off one character pastes onto another with the same rig — which
covers most of the library, because those models came out of the same
generator. Anything the target model does not have is skipped, and gerak says
how many.

**Paste ⇄** is the one worth knowing about. It swaps left for right and
mirrors the rotation, so you pose the first half of a walk, paste it flipped
twelve frames later, and the other leg is done. A joint with no opposite
number — a spine, a head — is mirrored where it stands.

Finding the opposite joint is harder than swapping the word, and this is the
bit that used to be broken: a Meshy rig writes the side into the middle of a
run-together name and hangs a node number on the end, and **the number is
different on the two sides** — `mixamorigLeftArm_29` pairs with
`mixamorigRightArm_14`. Swapping the word alone produces a name that exists
nowhere, so the old Mirror button quietly found nothing on most of the models
here. It now matches on the name with the numbering ignored.
