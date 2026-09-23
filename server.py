#!/usr/bin/env python3
"""
gerak - the local server.

gerak ("motion") is the app where you open a model that already lives on this
Mac, click its joints, and pose it into an animation by hand.

This file does four things and nothing else:

  1. finds every 3D model on the machine and works out which ones have a
     skeleton in them,
  2. serves the page you look at, and the model files it asks for,
  3. keeps the clips you author on disk as plain JSON, so an animation you
     made yesterday is still there tomorrow,
  4. later, drives Blender for the exports a browser cannot write.

Nothing here needs installing: it is the Python that comes with macOS.

On safety: a server on localhost with no lock on it can be driven by any web
page you happen to have open, so this one checks two things on every request -
a token made fresh each run, and that the request came from this app's own
address. Neither is optional. The same reasoning applies to the file paths it
will serve: a model is only handed over if it really sits inside one of the
folders listed in ROOTS.
"""

import base64
import json
import shutil
import subprocess
import mimetypes
import os
import re
import secrets
import struct
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

import gltf_anim

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
BLENDER_DIR = os.path.join(HERE, "blender")
HOME = os.path.expanduser("~")

# The reference search lives in common/, because boneka wants the same thing
# for checking a model against the animal it is meant to be, and one
# description of how to talk to Wikimedia is enough.
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "common"))
try:
    import refs as references                          # noqa: E402
except Exception as _err:                              # pragma: no cover
    references = None
    print("[gerak] reference search unavailable: %s" % _err, file=sys.stderr)

# Your clips and your exports are your work, not part of the program, so they
# live where you can find them in Finder rather than inside a project folder -
# and inside an app bundle they could not be written to at all.
DATA = os.environ.get("GERAK_DATA") or os.path.join(HOME, "Documents", "gerak")
CLIPS = os.path.join(DATA, "clips")
EXPORTS = os.path.join(DATA, "exports")
REFS = os.path.join(DATA, "references")
CACHE = os.path.join(DATA, ".library.json")
JOBS = os.path.join(DATA, ".jobs")

# Where a copy of a game asset goes before gerak writes over it. D-008 said
# the original is never touched; "Update the game" is the exception Luqman
# asked for, so the promise becomes this folder instead.
BACKUPS = os.path.join(DATA, "backups")

READY_MARK = "@@GERAK-READY@@"

BLENDER = os.environ.get(
    "GERAK_BLENDER", "/Applications/Blender.app/Contents/MacOS/Blender")

PORT = int(os.environ.get("GERAK_PORT", "8778"))

# The port actually bound. With GERAK_PORT=0 the system chooses one, so the
# number gerak was asked for and the number it is listening on are different -
# and the origin check below compares against the real one. Getting this wrong
# refused every POST the app made while letting every GET through, which reads
# like a broken feature rather than a locked door.
BOUND_PORT = PORT

TOKEN = secrets.token_urlsafe(18)

# The only folders gerak will ever read a model out of.
ROOTS = [
    os.path.join(HOME, "Desktop", "project"),
    os.path.join(HOME, "Documents"),
    os.path.join(HOME, "Downloads"),
]

MODEL_EXT = (".glb", ".gltf", ".fbx", ".blend", ".obj")
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv",
             ".godot", "Library", ".Trash", "addons"}


def log(*parts):
    sys.stderr.write("[gerak] %s\n" % " ".join(str(p) for p in parts))
    sys.stderr.flush()


# --------------------------------------------------------------------------
# the library: what models are on this Mac, and which of them are rigged
# --------------------------------------------------------------------------

def glb_summary(path):
    """Read the JSON header of a .glb without loading the whole file.

    A .glb is a 12-byte header, then a chunk of JSON describing the scene,
    then the binary blob of vertices. Everything we want for the library -
    whether there is a skeleton, how many joints, how many animations - is in
    that JSON chunk, which is usually a few kilobytes. So a 40 MB model costs
    us almost nothing to look at.
    """
    try:
        with open(path, "rb") as f:
            magic, _version, _length = struct.unpack("<III", f.read(12))
            if magic != 0x46546C67:          # 'glTF'
                return None
            chunk_len, _chunk_type = struct.unpack("<II", f.read(8))
            doc = json.loads(f.read(chunk_len).decode("utf-8"))
    except Exception:
        return None

    skins = doc.get("skins", [])
    joints = sum(len(s.get("joints", [])) for s in skins)
    return {
        "rigged": len(skins) > 0,
        "joints": joints,
        "anims": len(doc.get("animations", [])),
        "meshes": len(doc.get("meshes", [])),
    }


def scan_library():
    """Walk the roots and describe every model file found.

    The backups folder is left out. "Update the game" copies a character
    aside before it writes, so every push would otherwise add another entry
    to the library - the same character, under the same name, at a date -
    and the list would slowly fill with gerak's own safety copies. They are
    there to be restored from, not animated.
    """
    out = []
    skip_paths = {os.path.realpath(BACKUPS)}
    for root in ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            if os.path.realpath(dirpath) in skip_paths:
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames
                           if d not in SKIP_DIRS and not d.startswith(".")]
            for name in filenames:
                if not name.lower().endswith(MODEL_EXT):
                    continue
                full = os.path.join(dirpath, name)
                try:
                    size = os.path.getsize(full)
                    mtime = os.path.getmtime(full)
                except OSError:
                    continue
                item = {
                    "path": full,
                    "name": name,
                    "folder": os.path.dirname(full).replace(HOME, "~"),
                    "ext": os.path.splitext(name)[1].lower().lstrip("."),
                    "size": size,
                    "mtime": mtime,
                    "rigged": False,
                    "joints": 0,
                    "anims": 0,
                }
                if item["ext"] == "glb":
                    summary = glb_summary(full)
                    if summary:
                        item.update(summary)
                out.append(item)
    out.sort(key=lambda i: (not i["rigged"], -i["mtime"]))
    return out


_library_lock = threading.Lock()


def get_library(refresh=False):
    with _library_lock:
        if not refresh and os.path.exists(CACHE):
            age = time.time() - os.path.getmtime(CACHE)
            if age < 3600:
                try:
                    with open(CACHE) as f:
                        return json.load(f)
                except Exception:
                    pass
        log("scanning for models...")
        started = time.time()
        items = scan_library()
        log("found %d models (%d rigged) in %.1fs"
            % (len(items), sum(1 for i in items if i["rigged"]),
               time.time() - started))
        with open(CACHE, "w") as f:
            json.dump(items, f)
        return items


# Files you opened or dropped by hand this run. The scanned folders cover
# almost everything, but a model dragged in off a USB stick is not in them,
# and refusing to open a file you just dropped on the window would be absurd.
# Nothing gets in here except through a request carrying this run's token,
# which means through gerak itself.
PERMITTED = set()
_permit_lock = threading.Lock()


def permit(path):
    try:
        real = os.path.realpath(path)
    except OSError:
        return None
    if not os.path.isfile(real):
        return None
    with _permit_lock:
        PERMITTED.add(real)
    return real


def allowed(path):
    """True only if this really is a file gerak is entitled to read.

    realpath first, so a path with .. in it, or a symlink pointing out of the
    folder, is resolved before it is compared - checking the string alone
    would let both of those through.
    """
    try:
        real = os.path.realpath(path)
    except OSError:
        return False
    if not os.path.isfile(real):
        return False
    if any(real.startswith(os.path.realpath(r) + os.sep) for r in ROOTS):
        return True
    with _permit_lock:
        return real in PERMITTED


# --------------------------------------------------------------------------
# clips: the animations you author, kept as plain JSON
# --------------------------------------------------------------------------

SAFE_NAME = re.compile(r"[^a-z0-9_-]+")


def clip_path(name):
    slug = SAFE_NAME.sub("-", name.lower()).strip("-") or "clip"
    return os.path.join(CLIPS, slug + ".json")


def list_clips():
    out = []
    for name in sorted(os.listdir(CLIPS)):
        if not name.endswith(".json"):
            continue
        full = os.path.join(CLIPS, name)
        try:
            with open(full) as f:
                doc = json.load(f)
        except Exception:
            continue
        # Is this clip newer than the model it was made on?
        #
        # That is how gerak knows, when a character is reopened, whether a
        # saved clip is work the game's file has not caught up with or an old
        # copy of something already pushed. Comparing here rather than in the
        # page because the page's library list can be an hour stale, and this
        # decides whether an edit reappears or is quietly ignored.
        model = doc.get("model", "")
        try:
            model_at = os.path.getmtime(model) if model else 0
        except OSError:
            model_at = 0
        clip_at = os.path.getmtime(full)

        out.append({
            "slug": name[:-5],
            "name": doc.get("name", name[:-5]),
            "model": model,
            "modelName": os.path.basename(model),
            "anim": doc.get("anim", ""),
            "fps": doc.get("fps", 24),
            "frames": doc.get("frames", 0),
            "keys": sum(len(v) for v in doc.get("tracks", {}).values()),
            "mtime": clip_at,
            "ahead": bool(model_at) and clip_at > model_at,
        })
    out.sort(key=lambda c: -c["mtime"])
    return out


# --------------------------------------------------------------------------
# games: where an animation goes when it leaves gerak
# --------------------------------------------------------------------------

GAMES = os.path.join(HOME, "Desktop", "project", "game")

# Where a character goes in a game that has not seen it before. Every one of
# his Godot projects keeps its models under assets/, so this is a guess that
# is right rather than a convention being imposed.
ASSET_GUESSES = [
    os.path.join("assets", "characters"),
    os.path.join("assets", "models"),
    "assets",
]

# The files a Godot project could be naming an animation in. A .gd script
# plays one by name; a .tscn or a .tres can hold the name in an exported
# property or an AnimationTree.
SCRIPT_EXT = (".gd", ".tscn", ".tres", ".cs", ".json", ".cfg")


def game_of(path):
    """Which game project this file lives in, if it lives in one at all.

    This is what decides whether the "Update the game" button is a
    write-back or a "which game?" question. It answers by where the file
    sits, not by anything recorded, so moving a model between projects needs
    nothing to be told to gerak.
    """
    try:
        real = os.path.realpath(path)
        root = os.path.realpath(GAMES)
    except OSError:
        return None
    if not real.startswith(root + os.sep):
        return None
    name = real[len(root) + 1:].split(os.sep)[0]
    folder = os.path.join(root, name)
    if not os.path.isdir(folder):
        return None
    return {
        "game": name,
        "root": folder,
        "shownRoot": folder.replace(HOME, "~"),
        "relative": os.path.relpath(real, folder),
        "godot": os.path.exists(os.path.join(folder, "project.godot")),
    }


def list_games():
    """Every game project on the Mac, with the folder a character goes in."""
    out = []
    if not os.path.isdir(GAMES):
        return out
    for name in sorted(os.listdir(GAMES)):
        folder = os.path.join(GAMES, name)
        if name.startswith(".") or not os.path.isdir(folder):
            continue
        assets = next((g for g in ASSET_GUESSES
                       if os.path.isdir(os.path.join(folder, g))), None)
        out.append({
            "game": name,
            "root": folder,
            "assets": os.path.join(folder, assets) if assets else None,
            "shownAssets": (os.path.join(folder, assets).replace(HOME, "~")
                            if assets else None),
            "godot": os.path.exists(os.path.join(folder, "project.godot")),
        })
    return out


def mentions(root, names, keep=8):
    """Find where a game's own files say each animation's name out loud.

    This answers two questions with one walk: whether an animation is used by
    the game at all, which is the tag beside the keys in the Animations
    panel, and exactly which lines would break if it were deleted, which is
    the warning in front of deleting one.

    Names are looked for **in quotes** - Godot writes play("run2") and
    &"run2" - because a bare word like "run" appears in a hundred places that
    have nothing to do with an animation. The closing quote also stops "run"
    matching inside "run2".

    One combined pattern, one pass per line. Asking about one name and asking
    about all fifty-three therefore cost the same walk, which matters because
    the panel asks about all of them every time a character is opened.

    `keep` is how many example lines are kept per name; the count is of every
    hit, not only the kept ones. An earlier version capped the *total* hits
    and returned early, which was harmless for a two-name merge and quietly
    wrong here: every name the walk had not reached yet came back as unused.
    """
    wanted = sorted({n for n in names if n}, key=len, reverse=True)
    if not wanted or not os.path.isdir(root):
        return {}, {}

    pattern = re.compile(r"""["'&](%s)["']"""
                         % "|".join(re.escape(n) for n in wanted))
    hits = {n: [] for n in wanted}
    counts = {n: 0 for n in wanted}

    for here, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for file in files:
            if not file.endswith(SCRIPT_EXT):
                continue
            full = os.path.join(here, file)
            try:
                with open(full, "r", errors="replace") as f:
                    lines = f.readlines()
            except OSError:
                continue
            for i, line in enumerate(lines, 1):
                seen = set()
                for match in pattern.finditer(line):
                    name = match.group(1)
                    if name in seen:        # one line naming it twice is one line
                        continue
                    seen.add(name)
                    counts[name] += 1
                    if len(hits[name]) < keep:
                        hits[name].append({
                            "file": os.path.relpath(full, root),
                            "line": i,
                            "text": line.strip()[:160],
                        })

    return {k: v for k, v in hits.items() if v}, counts


# --------------------------------------------------------------------------
# Blender, for the formats a browser cannot write
# --------------------------------------------------------------------------

BLENDER_MARK = "@@GERAK@@"


def blender_available():
    return os.path.exists(BLENDER) or shutil.which("blender") is not None


def run_blender(job, timeout=900):
    """Run one job through headless Blender and hand back what it reported.

    Blender is run per job rather than kept alive. A conversion takes a couple
    of seconds and a render takes some tens of seconds, so the half second it
    costs to start is not worth the complication of a long-running process
    that has to be watched, restarted and cleaned up.
    """
    exe = BLENDER if os.path.exists(BLENDER) else shutil.which("blender")
    if not exe:
        return {"ok": False, "written": [],
                "problems": ["Blender was not found at %s. Set GERAK_BLENDER "
                             "to where it is installed." % BLENDER]}

    os.makedirs(JOBS, exist_ok=True)
    job_file = os.path.join(JOBS, "job-%s.json" % secrets.token_hex(6))
    with open(job_file, "w") as f:
        json.dump(job, f)

    cmd = [exe, "--background", "--factory-startup",
           "--python", os.path.join(BLENDER_DIR, "worker.py"),
           "--", job_file]
    log("blender:", " ".join(job.get("targets", [])), "on",
        os.path.basename(job.get("source", "?")))
    started = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "written": [],
                "problems": ["Blender took longer than %d seconds and was stopped."
                             % timeout]}
    finally:
        try:
            os.remove(job_file)
        except OSError:
            pass

    for line in proc.stdout.splitlines():
        if line.startswith(BLENDER_MARK):
            result = json.loads(line[len(BLENDER_MARK):])
            result["seconds"] = round(time.time() - started, 1)
            log("blender finished in %.1fs" % result["seconds"])
            return result

    tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
    return {"ok": False, "written": [],
            "problems": ["Blender said nothing back. " + " / ".join(tail)]}


# --------------------------------------------------------------------------
# the web server
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def handle_one_request(self):
        """A browser closing a connection is not an error.

        When the app quits, the page's open connections are cut, and the
        stock handler prints a full traceback for each one. They are noise,
        and they bury anything that does matter in the log.
        """
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    # -- guards ------------------------------------------------------------

    def authorised(self):
        """Every request must carry this run's token and come from us.

        The token stops another program on the machine from driving gerak.
        The Origin check stops a web page you have open in another tab from
        doing it: a POST with a plain content type needs no CORS preflight,
        so the browser would happily send it.
        """
        origin = self.headers.get("Origin")
        if origin and origin not in ("http://127.0.0.1:%d" % BOUND_PORT,
                                     "http://localhost:%d" % BOUND_PORT):
            return False
        query = parse_qs(urlparse(self.path).query)
        token = (self.headers.get("X-Gerak-Token")
                 or (query.get("t") or [""])[0])
        return secrets.compare_digest(token, TOKEN)

    # -- replies -----------------------------------------------------------

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body, ctype, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype=None):
        if not ctype:
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            return self.send_json({"error": "cannot read file"}, 404)
        self.send_bytes(body, ctype)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    # -- routes ------------------------------------------------------------

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        query = parse_qs(url.query)

        # The page itself is the one thing served without a token, because
        # this is where the token is handed over in the first place.
        if path in ("/", "/index.html"):
            try:
                with open(os.path.join(WEB, "index.html")) as f:
                    page = f.read()
            except OSError:
                return self.send_json({"error": "web/index.html missing"}, 500)
            page = page.replace("__GERAK_TOKEN__", TOKEN)
            return self.send_bytes(page.encode("utf-8"), "text/html; charset=utf-8")

        # The test pages, served the same way. They carry no data of their
        # own; everything they touch goes through the guarded API below.
        if path.startswith("/tests/"):
            rel = path[len("/tests/"):]
            base = os.path.realpath(os.path.join(HERE, "tests"))
            full = os.path.realpath(os.path.join(base, rel))
            if not full.startswith(base + os.sep):
                return self.send_json({"error": "no"}, 403)
            return self.send_file(full, "text/html; charset=utf-8")

        if path.startswith("/web/"):
            rel = path[len("/web/"):]
            full = os.path.realpath(os.path.join(WEB, rel))
            if not full.startswith(os.path.realpath(WEB) + os.sep):
                return self.send_json({"error": "no"}, 403)
            ctype = None
            if full.endswith(".js"):
                ctype = "text/javascript; charset=utf-8"
            elif full.endswith(".css"):
                ctype = "text/css; charset=utf-8"
            return self.send_file(full, ctype)

        if not self.authorised():
            return self.send_json({"error": "not authorised"}, 403)

        if path == "/api/capabilities":
            return self.send_json({
                "blender": blender_available(),
                "blenderPath": BLENDER,
                "exports": EXPORTS.replace(HOME, "~"),
                "data": DATA.replace(HOME, "~"),
            })

        if path == "/api/library":
            refresh = (query.get("refresh") or ["0"])[0] == "1"
            return self.send_json({"items": get_library(refresh)})

        if path == "/api/games":
            # Two answers in one: which game the open model belongs to, and
            # which games there are to send it to if it belongs to none.
            target = unquote((query.get("path") or [""])[0])
            here = game_of(target) if target else None
            return self.send_json({
                "here": here,
                "games": list_games(),
                "pushable": bool(target and target.lower().endswith(".glb")),
                "backups": BACKUPS.replace(HOME, "~"),
            })

        if path == "/api/model":
            target = unquote((query.get("path") or [""])[0])
            if not allowed(target):
                return self.send_json({"error": "outside the allowed folders"}, 403)
            return self.send_file(target, "model/gltf-binary")

        if path == "/api/describe":
            # What the page needs to open a file that is not in the library:
            # the same row shape the library hands out.
            target = unquote((query.get("path") or [""])[0])
            if not allowed(target):
                return self.send_json({"error": "gerak was not given that file"}, 403)
            real = os.path.realpath(target)
            item = {
                "path": real,
                "name": os.path.basename(real),
                "folder": os.path.dirname(real).replace(HOME, "~"),
                "ext": os.path.splitext(real)[1].lower().lstrip("."),
                "size": os.path.getsize(real),
                "mtime": os.path.getmtime(real),
                "rigged": False, "joints": 0, "anims": 0, "meshes": 0,
            }
            if item["ext"] == "glb":
                summary = glb_summary(real)
                if summary:
                    item.update(summary)
            return self.send_json(item)

        if path == "/api/clips":
            return self.send_json({"items": list_clips()})

        if path == "/api/clip":
            slug = (query.get("slug") or [""])[0]
            full = clip_path(slug)
            if not os.path.exists(full):
                return self.send_json({"error": "no such clip"}, 404)
            return self.send_file(full, "application/json")

        # ── reference pictures ────────────────────────────────────
        #
        # Searching, and then serving the picture. Both go through the server:
        # the page never talks to Wikimedia itself, so the origin rule stays
        # true for everything on screen and Commons never learns what he is
        # animating.

        if path == "/api/refs":
            if references is None:
                return self.send_json({"error": "reference search is not available"}, 503)
            term = (query.get("q") or [""])[0]
            kind = (query.get("kind") or ["all"])[0]
            try:
                found = references.look(term, kind, 12)
            except Exception as err:
                log("reference search failed:", err)
                return self.send_json({"error": str(err)}, 502)
            return self.send_json({"items": found, "query": term, "kind": kind})

        if path == "/api/ref-image":
            if references is None:
                return self.send_json({"error": "no"}, 503)
            url = unquote((query.get("url") or [""])[0])
            try:
                body, ctype = references.fetch(url)
            except ValueError:
                return self.send_json({"error": "not a Wikimedia image"}, 403)
            except Exception as err:
                return self.send_json({"error": str(err)}, 502)
            return self.send_bytes(body, ctype)

        if path == "/api/ref-file":
            # Anything already pinned, served off the disk. Confined to the
            # references folder: this route exists to show pictures, not to
            # read the machine.
            target = os.path.realpath(unquote((query.get("path") or [""])[0]))
            if not target.startswith(os.path.realpath(REFS) + os.sep) \
                    or not os.path.isfile(target):
                return self.send_json({"error": "no"}, 403)
            return self.send_file(target)

        return self.send_json({"error": "unknown route"}, 404)

    def do_POST(self):
        if not self.authorised():
            return self.send_json({"error": "not authorised"}, 403)
        path = urlparse(self.path).path
        body = self.read_body()

        if path == "/api/permit":
            # The app hands over a file you chose or dropped, so the page may
            # then open it like any other model.
            wanted = body.get("paths") or ([body.get("path")] if body.get("path") else [])
            ok, refused = [], []
            for one in wanted:
                real = permit(one)
                (ok if real else refused).append(one)
            if ok:
                log("permitted", ", ".join(os.path.basename(p) for p in ok))
            return self.send_json({"ok": bool(ok), "paths": ok, "refused": refused})

        if path == "/api/clip/save":
            name = body.get("name") or "clip"
            full = clip_path(name)
            with open(full, "w") as f:
                json.dump(body, f, indent=1)
            log("saved clip", os.path.basename(full))
            return self.send_json({"ok": True,
                                   "slug": os.path.basename(full)[:-5]})

        if path == "/api/export/save":
            # The browser can build a .glb but it cannot choose where on the
            # disk to put it, so it hands the bytes here and we write them
            # into exports/ where the rest of the app can find them again.
            name = SAFE_NAME.sub("-", (body.get("name") or "clip").lower()).strip("-")
            ext = (body.get("ext") or "glb").lower()
            if ext not in ("glb", "gltf"):
                return self.send_json({"error": "unsupported format"}, 400)
            try:
                raw = base64.b64decode(body.get("data") or "")
            except Exception:
                return self.send_json({"error": "bad data"}, 400)
            if not raw:
                return self.send_json({"error": "empty file"}, 400)
            full = os.path.join(EXPORTS, "%s.%s" % (name or "clip", ext))
            with open(full, "wb") as f:
                f.write(raw)
            log("exported", os.path.basename(full), "%.1f KB" % (len(raw) / 1024))
            return self.send_json({"ok": True, "path": full,
                                   "shown": full.replace(HOME, "~"),
                                   "bytes": len(raw)})

        if path == "/api/rig":
            # Build a skeleton onto a model that has none, and skin it.
            # The model must be one of yours; the rigged copy is written into
            # exports/ rather than over the original, which is never touched.
            source = body.get("source") or ""
            if not allowed(source):
                return self.send_json({"error": "outside the allowed folders"}, 403)
            joints = body.get("joints") or []
            if not joints:
                return self.send_json({"error": "no joints to build from"}, 400)

            name = SAFE_NAME.sub("-", (body.get("name") or "rigged").lower()).strip("-")
            out = os.path.join(EXPORTS, "%s-rigged.glb" % (name or "model"))
            result = run_blender({
                "job": "rig",
                "source": os.path.realpath(source),
                "joints": joints,
                "out": out,
                "name": body.get("rigName") or "gerak_rig",
            })
            if result.get("out"):
                result["shown"] = result["out"].replace(HOME, "~")
            return self.send_json(result)

        if path == "/api/convert":
            # Hand a .glb that gerak has already written over to Blender, for
            # the formats it cannot write itself.
            source = body.get("path") or ""
            real = os.path.realpath(source)
            if not real.startswith(os.path.realpath(EXPORTS) + os.sep) \
                    or not os.path.isfile(real):
                return self.send_json({"error": "that is not a gerak export"}, 403)

            targets = [t for t in (body.get("targets") or [])
                       if t in ("fbx", "blend", "mp4")]
            if not targets:
                return self.send_json({"error": "nothing to convert to"}, 400)

            result = run_blender({
                "source": real,
                "out_dir": EXPORTS,
                "name": SAFE_NAME.sub("-", (body.get("name") or "clip").lower()).strip("-"),
                "fps": int(body.get("fps") or 24),
                "targets": targets,
                "spin": bool(body.get("spin")),
            })
            for item in result.get("written", []):
                item["shown"] = item["path"].replace(HOME, "~")
            return self.send_json(result)

        if path == "/api/mentions":
            # Which of the game's own files name these animations. The merge
            # dialog asks this before it offers to delete one.
            model = body.get("model") or ""
            if not allowed(model):
                return self.send_json({"error": "outside the allowed folders"}, 403)
            where = game_of(model)
            if not where:
                return self.send_json({"game": None, "hits": {}, "counts": {}})
            hits, counts = mentions(where["root"], body.get("names") or [])
            return self.send_json({
                "game": where["game"],
                "hits": hits,        # example lines, for the warning
                "counts": counts,    # every mention, for the used/unused tag
            })

        if path == "/api/push":
            # Put the edited animations back into the file the game loads.
            #
            # This is the one place gerak writes over something it did not
            # make, so it is also the one place that takes a copy first. The
            # animations nobody edited are not rewritten at all - they keep
            # the curves the original file had, down to the interpolation.
            model = body.get("model") or ""
            if not allowed(model):
                return self.send_json({"error": "outside the allowed folders"}, 403)

            clips = body.get("clips") or []
            remove = [n for n in (body.get("remove") or []) if n]
            if not clips and not remove:
                return self.send_json({"error": "nothing has been edited yet"}, 400)

            # Either write back into the file it came from, or - when it came
            # from somewhere that is not a game - put a copy into the game
            # that was chosen and update that instead.
            into = body.get("game") or ""
            if into:
                chosen = next((g for g in list_games() if g["game"] == into), None)
                if not chosen:
                    return self.send_json({"error": "no game called %r" % into}, 400)
                folder = chosen["assets"] or os.path.join(
                    chosen["root"], "assets", "characters")
                os.makedirs(folder, exist_ok=True)
                target = os.path.join(folder, os.path.basename(model))
                fresh = not os.path.exists(target)
                if fresh:
                    shutil.copy2(os.path.realpath(model), target)
            else:
                target = os.path.realpath(model)
                fresh = False

            if not target.lower().endswith(".glb"):
                return self.send_json({
                    "error": "only a .glb can be updated in place. Export this "
                             "one and put the .glb in the game first."}, 400)

            try:
                result = gltf_anim.push(
                    target, clips, remove=remove,
                    backup_into=None if fresh else BACKUPS)
            except gltf_anim.GlbError as err:
                return self.send_json({"error": str(err)}, 400)
            except Exception as err:                       # pragma: no cover
                log("push failed:", repr(err))
                return self.send_json({"error": "could not write it: %s" % err}, 500)

            where = game_of(target)
            result["game"] = where["game"] if where else None
            result["godot"] = bool(where and where["godot"])
            result["copied"] = fresh
            result["shown"] = target.replace(HOME, "~")
            if result.get("backup"):
                result["shownBackup"] = result["backup"].replace(HOME, "~")
            log("pushed", ", ".join(result["replaced"] + result["added"]) or "nothing",
                "into", os.path.basename(target),
                "(%d → %d KB)" % (result["bytes_before"] // 1024,
                                  result["bytes_after"] // 1024))
            return self.send_json(result)

        if path == "/api/clip/delete":
            full = clip_path(body.get("slug") or "")
            if os.path.exists(full):
                os.remove(full)
            return self.send_json({"ok": True})

        if path == "/api/ref-pin":
            # Keep a reference beside the work rather than at a URL.
            #
            # A reference that lives on the internet is a reference that is
            # gone when the link rots or the laptop is on a train, and the
            # whole point of pinning one is that it is there next time the
            # clip is opened.
            if references is None:
                return self.send_json({"error": "reference search is not available"}, 503)
            url = body.get("url") or ""
            slug = SAFE_NAME.sub("-", (body.get("clip") or "loose").lower()).strip("-")
            folder = os.path.join(REFS, slug or "loose")
            try:
                saved = references.keep_local(url, folder, body.get("name"))
            except ValueError:
                return self.send_json({"error": "not a Wikimedia image"}, 403)
            except Exception as err:
                log("could not pin a reference:", err)
                return self.send_json({"error": str(err)}, 502)

            # A GIF is a sequence already, so pull it apart now: stepping it
            # against the timeline and playing it as a flipbook both want the
            # frames as separate pictures, and doing it once on pin beats
            # doing it every time the panel opens.
            frames = references.split_frames(saved, os.path.join(folder, "frames"))
            log("pinned %s (%d frames)" % (os.path.basename(saved), len(frames)))
            return self.send_json({
                "ok": True,
                "path": saved,
                "shown": saved.replace(HOME, "~"),
                "frames": frames,
                "count": len(frames),
            })

        if path == "/api/ref-drop":
            # One of his own pictures, dropped on the panel.
            source = os.path.expanduser(body.get("path") or "")
            if not source or not os.path.isfile(source) or not allowed(source):
                return self.send_json({"error": "that file is not one I can read"}, 403)
            slug = SAFE_NAME.sub("-", (body.get("clip") or "loose").lower()).strip("-")
            folder = os.path.join(REFS, slug or "loose")
            os.makedirs(folder, exist_ok=True)
            saved = os.path.join(folder, os.path.basename(source))
            shutil.copy2(source, saved)
            frames = references.split_frames(saved, os.path.join(folder, "frames")) \
                if references else []
            return self.send_json({
                "ok": True, "path": saved, "shown": saved.replace(HOME, "~"),
                "frames": frames, "count": len(frames),
            })

        if path == "/api/reveal":
            # Open a finished export in Finder, so the file is where you can
            # see it rather than only named in a message.
            target = body.get("path") or EXPORTS
            real = os.path.realpath(target)
            # Your own work in ~/Documents/gerak, or a model gerak is
            # entitled to read anyway. The check named HERE alone until the
            # data folder moved out of the repo in D-011, after which it
            # could not reveal a single thing it had written.
            if real.startswith(os.path.realpath(DATA)) or allowed(real):
                subprocess.run(["open", "-R", real], check=False)
                return self.send_json({"ok": True})
            return self.send_json({"error": "no"}, 403)

        return self.send_json({"error": "unknown route"}, 404)


def migrate_old_data():
    """Bring across clips written before the data folder moved.

    Up to 2026-09-21 clips and exports were written next to the code. That is
    the wrong place for your own work, and inside an app bundle it is not even
    writable, so they moved to ~/Documents/gerak. Anything left behind is
    carried over once, and the old folder is left alone.
    """
    for name, target in (("clips", CLIPS), ("exports", EXPORTS)):
        old = os.path.join(HERE, name)
        if not os.path.isdir(old) or os.path.realpath(old) == os.path.realpath(target):
            continue
        moved = 0
        for entry in os.listdir(old):
            src = os.path.join(old, entry)
            dst = os.path.join(target, entry)
            if os.path.isfile(src) and not os.path.exists(dst):
                shutil.copy2(src, dst)
                moved += 1
        if moved:
            log("brought %d file(s) across from the old %s folder" % (moved, name))


def watch_parent():
    """Stop when whatever started us has gone.

    The app stops the server when it quits, but a force-quit or a crash never
    reaches that code, and an orphaned server would sit holding a port and a
    copy of the library forever. So if we were started by something that names
    itself, we check on it once a second and let ourselves out when it goes.
    """
    named = os.environ.get("GERAK_PARENT")
    if not named or not named.isdigit():
        log("no parent named, so nothing to watch (started by hand)")
        return
    started_under = os.getppid()
    log("watching parent %s (pid %d)" % (named, started_under))

    def watch():
        while True:
            time.sleep(1)
            # Watch who our parent IS, not whether the old one answers a
            # signal. A killed process stays in the table as a zombie until
            # its own parent reaps it, and os.kill(zombie, 0) succeeds - so
            # asking that way, gerak would happily outlive a force-quit.
            # When the app goes, this process is handed to launchd instead.
            if os.getppid() != started_under:
                # Say so if anything is still listening, but never let that
                # stop us leaving: our stderr is a pipe to the app that just
                # died, so writing to it raises and would kill this thread
                # before it got to the line that matters.
                try:
                    log("the app that started gerak has gone; stopping")
                except Exception:
                    pass
                os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def main():
    for folder in (DATA, CLIPS, EXPORTS, JOBS, REFS, BACKUPS):
        os.makedirs(folder, exist_ok=True)
    migrate_old_data()

    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as err:
        if err.errno == 48:
            log("port %d is already in use - gerak may already be running." % PORT)
            log("close the other one, or start this with GERAK_PORT=8779 gerak")
            return 1
        raise

    # With GERAK_PORT=0 the system hands out a free port, which is how the
    # app starts a second gerak without colliding with one in a browser.
    global BOUND_PORT
    BOUND_PORT = server.server_address[1]
    port = BOUND_PORT
    url = "http://127.0.0.1:%d/?t=%s" % (port, TOKEN)

    log("gerak is running")
    log(url)
    log("your clips and exports are in %s" % DATA.replace(HOME, "~"))
    # One machine-readable line, for the app that started this process.
    print("%s%s" % (READY_MARK, json.dumps(
        {"url": url, "port": port, "token": TOKEN, "data": DATA})), flush=True)

    watch_parent()
    threading.Thread(target=get_library, daemon=True).start()
    if "--no-open" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopped")


if __name__ == "__main__":
    main()
