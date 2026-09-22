/* Reference pictures, beside the thing you are animating.
 *
 * Animating from memory is how a walk comes out looking like somebody wading.
 * The question is never "what does a walking person look like" — it is "where
 * is the far leg on frame six", and the only honest answer is a photograph of
 * somebody actually walking, on frame six.
 *
 * Two halves:
 *
 *   the drawer   a search over Wikimedia Commons. Motion studies first —
 *                Muybridge photographed humans and animals frame by frame in
 *                the 1880s and the plates are public domain, many of them
 *                already assembled into animated GIFs. A GIF is a sequence
 *                already, so it can be stepped and flipped through without
 *                anything being guessed.
 *
 *   the pin      one picture floating over the viewport, draggable, sized and
 *                faded to taste, so you pose the leg against the photograph
 *                rather than against your memory of it.
 *
 * A pinned reference is saved with the clip, so reopening a walk cycle next
 * week puts the reference back on screen with it.
 */

const $ = (s) => document.querySelector(s);

export class Reference {
  /**
   * @param {object} deps
   * @param {function} deps.api        talk to gerak's own server
   * @param {function} deps.say        show a message
   * @param {function} deps.clipName   what the current clip is called
   * @param {function} deps.onChange   called when the pin changes, to mark dirty
   */
  constructor({ api, say, clipName, onChange }) {
    this.api = api;
    this.say = say;
    this.clipName = clipName;
    this.onChange = onChange || (() => {});

    this.results = [];
    this.kind = 'motion';
    this.pin = null;          // { path, frames[], count, title, credit, licence }
    this.frame = 0;           // which reference frame is showing
    this.follow = true;       // step with the timeline
    this.flipping = null;     // the flipbook timer

    this._build();
  }

  // ── the drawer ────────────────────────────────────────────────────

  _build() {
    this.drawer = $('#ref-drawer');
    this.grid = $('#ref-results');
    this.box = $('#ref-pin');

    $('#btn-reference').onclick = () => this.toggle();
    $('#ref-close').onclick = () => this.toggle(false);
    $('#ref-go').onclick = () => this.search();
    $('#ref-q').onkeydown = (e) => { if (e.key === 'Enter') this.search(); };

    $('#ref-kinds').querySelectorAll('.seg-btn').forEach((button) => {
      button.onclick = () => {
        this.kind = button.dataset.kind;
        $('#ref-kinds').querySelectorAll('.seg-btn')
          .forEach((x) => x.classList.toggle('is-on', x === button));
        if ($('#ref-q').value.trim()) this.search();
      };
    });

    // The pin's own controls.
    $('#ref-opacity').oninput = (e) => {
      this.box.style.opacity = e.target.value;
      $('#ref-opacity-n').textContent = `${Math.round(e.target.value * 100)}%`;
    };
    $('#ref-unpin').onclick = () => this.unpin();
    $('#ref-flip').onclick = () => this.flip();
    $('#ref-follow').onchange = (e) => {
      this.follow = e.target.checked;
      if (this.follow) this.stopFlip();
    };
    $('#ref-step').oninput = (e) => {
      this.follow = false;
      $('#ref-follow').checked = false;
      this.showFrame(parseInt(e.target.value, 10));
    };

    this._draggable();

    // A picture of his own, dropped straight on the drawer.
    for (const target of [this.drawer]) {
      target.addEventListener('dragover', (e) => {
        e.preventDefault();
        target.classList.add('is-dropping');
      });
      target.addEventListener('dragleave', () => target.classList.remove('is-dropping'));
      target.addEventListener('drop', async (e) => {
        e.preventDefault();
        target.classList.remove('is-dropping');
        const file = e.dataTransfer.files[0];
        if (!file) return;
        if (!file.path) {
          this.say('Drop it from Finder — a picture dragged out of a browser '
            + 'has no file behind it', true);
          return;
        }
        await this.api('/api/permit', { path: file.path });
        const answer = await this.api('/api/ref-drop',
          { path: file.path, clip: this.clipName() });
        if (answer.error) { this.say(answer.error, true); return; }
        this.usePin({ ...answer, title: file.name, licence: 'your own picture' });
      });
    }
  }

  toggle(on) {
    const want = on === undefined ? this.drawer.hidden : on;
    this.drawer.hidden = !want;
    $('#btn-reference').classList.toggle('is-on', want);
    // The viewport tools need to know, so they can wrap rather than disappear
    // behind the drawer.
    this.drawer.closest('.stage').classList.toggle('has-ref', want);
    if (want) $('#ref-q').focus();
  }

  // ── searching ─────────────────────────────────────────────────────

  async search() {
    const term = $('#ref-q').value.trim();
    if (!term) return;
    this.grid.innerHTML = '<p class="ref-note">Looking…</p>';

    let answer;
    try {
      answer = await this.api(`/api/refs?q=${encodeURIComponent(term)}&kind=${this.kind}`);
    } catch (err) {
      this.grid.innerHTML = `<p class="ref-note">${escape(err.message)}</p>`;
      return;
    }
    if (answer.error) {
      this.grid.innerHTML = `<p class="ref-note">${escape(answer.error)}</p>`;
      return;
    }

    this.results = answer.items || [];
    if (!this.results.length) {
      this.grid.innerHTML = `<p class="ref-note">Nothing for “${escape(term)}”.`
        + (this.kind === 'motion'
          ? ' Muybridge photographed a great deal but not everything — try Photographs.'
          : '') + '</p>';
      return;
    }
    this.paint();
  }

  paint() {
    this.grid.innerHTML = this.results.map((item, index) => `
      <button class="ref-card" data-index="${index}" title="${escape(item.title)}">
        <span class="ref-shot">
          <img src="/api/ref-image?url=${encodeURIComponent(item.thumb)}&t=${TOKEN}"
               alt="" loading="lazy">
          ${item.sequence ? '<span class="ref-badge">sequence</span>' : ''}
        </span>
        <span class="ref-name">${escape(item.title)}</span>
        <span class="ref-licence">${escape(item.licence || 'unknown licence')}</span>
      </button>`).join('');

    this.grid.querySelectorAll('.ref-card').forEach((card) => {
      card.onclick = () => this.take(this.results[parseInt(card.dataset.index, 10)]);
    });
  }

  /** Pin one of the results: fetch it, keep it, pull it apart if it moves. */
  async take(item) {
    this.say(`Getting ${item.title}…`);
    let answer;
    try {
      answer = await this.api('/api/ref-pin', {
        url: item.full || item.thumb,
        clip: this.clipName(),
        name: item.title,
      });
    } catch (err) {
      this.say(`Could not pin that: ${err.message}`, true);
      return;
    }
    if (answer.error) { this.say(answer.error, true); return; }
    this.usePin({ ...answer, title: item.title,
                  licence: item.licence, credit: item.credit, page: item.page });
  }

  // ── the pinned picture ────────────────────────────────────────────

  usePin(pin) {
    this.pin = pin;
    this.frame = 0;
    this.box.hidden = false;
    this.stopFlip();

    $('#ref-pin-title').textContent = pin.title;
    $('#ref-pin-credit').textContent = [pin.credit, pin.licence]
      .filter(Boolean).join(' · ');

    // Only a sequence can be stepped or flipped, so the controls for those
    // appear only when there is something to step through. A single
    // photograph with a dead frame slider beside it is a small lie.
    const many = pin.count > 1;
    $('#ref-seq').hidden = !many;
    if (many) {
      $('#ref-step').max = String(pin.count - 1);
      $('#ref-step').value = '0';
      this.follow = true;
      $('#ref-follow').checked = true;
    }

    this.showFrame(0);
    this.toggle(false);
    this.onChange();
    this.say(many ? `${pin.title} — ${pin.count} frames` : pin.title);
  }

  showFrame(index) {
    if (!this.pin) return;
    const count = this.pin.count || 0;
    const image = $('#ref-pin-img');
    if (count > 1) {
      this.frame = ((index % count) + count) % count;
      image.src = `/api/ref-file?path=${encodeURIComponent(this.pin.frames[this.frame])}&t=${TOKEN}`;
      $('#ref-step').value = String(this.frame);
      $('#ref-frame-n').textContent = `${this.frame + 1}/${count}`;
    } else {
      image.src = `/api/ref-file?path=${encodeURIComponent(this.pin.path)}&t=${TOKEN}`;
    }
  }

  /**
   * Called by the timeline. Maps where you are in your own animation onto
   * where you are in the reference, proportionally — a 12-frame Muybridge
   * walk against a 48-frame clip advances one reference frame every four.
   */
  atFrame(frame, total) {
    if (!this.pin || !this.follow || this.pin.count < 2) return;
    const span = Math.max(1, total || 1);
    const where = Math.floor((frame % span) / span * this.pin.count);
    if (where !== this.frame) this.showFrame(where);
  }

  flip() {
    if (!this.pin || this.pin.count < 2) return;
    if (this.flipping) { this.stopFlip(); return; }
    this.follow = false;
    $('#ref-follow').checked = false;
    $('#ref-flip').classList.add('is-on');
    $('#ref-flip').textContent = 'Stop';
    // Muybridge's own plates were shot at about twelve a second, which is
    // also close enough to the animation standard to compare timing against.
    this.flipping = setInterval(() => this.showFrame(this.frame + 1), 1000 / 12);
  }

  stopFlip() {
    if (!this.flipping) return;
    clearInterval(this.flipping);
    this.flipping = null;
    $('#ref-flip').classList.remove('is-on');
    $('#ref-flip').textContent = 'Flip';
  }

  unpin() {
    this.stopFlip();
    this.pin = null;
    this.box.hidden = true;
    this.onChange();
  }

  /* Dragging the picture around, and sizing it from its corner. Both in plain
   * pointer events rather than a library: it is twenty lines and a library
   * would be another thing vendored into the repository. */
  _draggable() {
    const bar = $('#ref-pin-bar');
    const grip = $('#ref-pin-grip');
    let from = null;

    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input')) return;
      from = { x: e.clientX, y: e.clientY,
               left: this.box.offsetLeft, top: this.box.offsetTop, mode: 'move' };
      bar.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointerdown', (e) => {
      from = { x: e.clientX, y: e.clientY,
               w: this.box.offsetWidth, mode: 'size' };
      grip.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });

    const move = (e) => {
      if (!from) return;
      const stage = this.box.parentElement.getBoundingClientRect();
      if (from.mode === 'move') {
        // Clamped to the stage. Dragged past the edge, a reference goes
        // somewhere there is no way to get it back from, and the only cure is
        // reloading the page.
        const w = this.box.offsetWidth;
        const h = this.box.offsetHeight;
        const left = from.left + (e.clientX - from.x);
        const top = from.top + (e.clientY - from.y);
        this.box.style.left = `${Math.min(Math.max(0, left), Math.max(0, stage.width - w))}px`;
        this.box.style.top = `${Math.min(Math.max(0, top), Math.max(0, stage.height - h))}px`;
        this.box.style.right = 'auto';
      } else {
        const wide = Math.max(140, from.w + (e.clientX - from.x));
        this.box.style.width = `${Math.min(wide, stage.width - this.box.offsetLeft)}px`;
      }
    };
    const up = () => { if (from) { from = null; this.onChange(); } };

    bar.addEventListener('pointermove', move);
    grip.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    grip.addEventListener('pointerup', up);
  }

  // ── travelling with the clip ──────────────────────────────────────

  toJSON() {
    if (!this.pin) return null;
    return {
      path: this.pin.path,
      frames: this.pin.frames || [],
      count: this.pin.count || 0,
      title: this.pin.title || '',
      credit: this.pin.credit || '',
      licence: this.pin.licence || '',
      page: this.pin.page || '',
      opacity: parseFloat($('#ref-opacity').value),
      follow: this.follow,
      at: { left: this.box.style.left, top: this.box.style.top,
            width: this.box.style.width },
    };
  }

  /** Put back what was saved. A missing file is said out loud rather than
   *  leaving an empty box that looks like a bug. */
  async fromJSON(doc) {
    this.unpin();
    if (!doc || !doc.path) return;
    this.usePin(doc);
    if (doc.opacity) {
      $('#ref-opacity').value = String(doc.opacity);
      $('#ref-opacity').dispatchEvent(new Event('input'));
    }
    if (doc.at) {
      if (doc.at.left) this.box.style.left = doc.at.left;
      if (doc.at.top) this.box.style.top = doc.at.top;
      if (doc.at.width) this.box.style.width = doc.at.width;
      if (doc.at.left) this.box.style.right = 'auto';
    }
    this.follow = doc.follow !== false;
    $('#ref-follow').checked = this.follow;

    // Check the picture is really still there.
    const image = $('#ref-pin-img');
    image.onerror = () => {
      this.say(`The reference ${doc.title || ''} is no longer on disk`, true);
      this.unpin();
    };
  }
}

const TOKEN = new URLSearchParams(location.search).get('t') || '';

function escape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
