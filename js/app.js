(() => {
  'use strict';

  const W = window.PLATE.width;
  const H = window.PLATE.height;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const settled = (anim) => anim.finished.catch(() => {});
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const T = (ms) => (reduced ? 1 : ms);

  const items = window.MATERIALS
    .filter((m) => window.SHAPES[m.id])
    .map((m, i) => ({ ...m, n: i + 1, shape: window.SHAPES[m.id] }));

  const body = document.body;
  const plate = $('plate');
  const svg = $('plate-svg');
  const tag = $('tag');
  const detail = $('detail');
  const stageImg = $('stage-specimen');
  const rig = $('film-rig');
  const film = $('film');
  const desc = $('desc');
  const flyer = $('flyer');
  const soundBtn = $('sound');
  const cover = $('cover');
  const setupFill = $('setup-fill');
  const setupPct = $('setup-pct');
  const filmLoader = $('film-loader');
  const library = $('library');

  // phones held upright get the plate turned a quarter so it fills the screen
  const rotatedQuery = matchMedia('(max-width: 820px) and (max-aspect-ratio: 1/1)');

  let view = null;        // 'cover' | 'library' | 'detail'
  let current = null;     // specimen shown on the slide
  let active = null;      // specimen under the pointer on the plate
  let token = 0;          // bumps on every transition so stale async steps bail out
  let pendingFlight = null;
  let flyerRect = null;
  let hideTimer = 0;
  let hinted = false;
  let keyboardUser = false;
  let settingUp = false;     // the cover is holding while the films download
  let libraryReady = false;
  let soundOn = true;
  try { soundOn = localStorage.getItem('samplebook-sound') !== 'off'; } catch (e) { /* storage unavailable */ }

  /* ─── Build the plate ─────────────────────────────────────── */

  function el(tagName, attrs) {
    const node = document.createElementNS(SVG_NS, tagName);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  const visLayer = el('g', { class: 'spec-layer' });
  const hitLayer = el('g', { class: 'hit-layer' });
  $('specimens').append(visLayer, hitLayer);

  items.forEach((it) => {
    const c = it.shape.cut;
    const vis = el('g', { class: 'spec-vis' });
    const cut = el('image', { class: 'spec-cut', href: c.src, x: c.x, y: c.y, width: c.w, height: c.h });
    vis.append(
      cut,
      el('path', { class: 'spec-halo', d: it.shape.d }),
      el('path', { class: 'spec-line', d: it.shape.d, pathLength: 1 }),
    );
    visLayer.append(vis);

    const hit = el('path', {
      class: 'spec-hit',
      d: it.shape.d,
      tabindex: 0,
      role: 'button',
      'aria-label': `No. ${pad(it.n)}, ${it.name}${it.film ? ', with film' : ''}`,
    });
    hitLayer.append(hit);

    it.vis = vis;
    it.cut = cut;
    it.hit = hit;

    hit.addEventListener('pointerenter', () => activate(it));
    hit.addEventListener('pointerleave', () => deactivate(it));
    hit.addEventListener('focus', () => activate(it));
    hit.addEventListener('blur', () => deactivate(it));
    hit.addEventListener('click', () => open(it));
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(it); }
    });
  });

  // strokes are drawn in user units, so keep them a constant screen width
  new ResizeObserver(() => {
    const across = rotatedQuery.matches ? plate.clientHeight : plate.clientWidth;
    svg.style.setProperty('--u', (W / Math.max(across, 1)).toFixed(3));
  }).observe(plate);


  /* ─── Hover: lift the specimen off the plate ──────────────── */

  function activate(it) {
    if (view !== 'library') return;
    clearTimeout(hideTimer);
    if (active && active !== it) active.vis.classList.remove('is-active');
    active = it;
    if (visLayer.lastChild !== it.vis) {
      visLayer.appendChild(it.vis);
      it.vis.getBoundingClientRect(); // restart transitions from the resting state
    }
    it.vis.classList.add('is-active');
    plate.classList.add('is-hovering');
    showTag(it);
    if (it.film && preload.parts.get(it.film) === 1) prefetchFilm(it);
  }

  function deactivate(it) {
    it.vis.classList.remove('is-active');
    if (active !== it) return;
    active = null;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (active) return;
      plate.classList.remove('is-hovering');
      tag.classList.remove('is-shown');
    }, 90);
  }

  function clearHover() {
    if (active) active.vis.classList.remove('is-active');
    active = null;
    plate.classList.remove('is-hovering');
    tag.classList.remove('is-shown');
  }

  function showTag(it) {
    const [x, y, w, h] = it.shape.bbox;
    const cx = (x + w / 2) / W;
    const below = y / H < 0.035;
    tag.style.left = `${cx * 100}%`;
    tag.style.top = `${((below ? y + h : y) / H) * 100}%`;
    tag.classList.toggle('is-below', below);
    tag.classList.toggle('is-left', cx < 0.1);
    tag.classList.toggle('is-right', cx > 0.9);
    tag.classList.toggle('has-film', Boolean(it.film));
    $('tag-no').textContent = `No. ${pad(it.n)}`;
    $('tag-name').textContent = it.name;
    tag.classList.add('is-shown');
  }

  function hint() {
    if (hinted || reduced) return;
    hinted = true;
    items.forEach((it, i) => {
      it.vis.style.setProperty('--d', `${(i * 0.035).toFixed(3)}s`);
      it.vis.classList.add('is-hint');
    });
    setTimeout(() => items.forEach((it) => it.vis.classList.remove('is-hint')), 2600);
  }

  /* ─── Preloading ──────────────────────────────────────────── */

  // phones get longer to fetch the films before the page moves on without them
  const isMobile = () => matchMedia('(pointer: coarse)').matches || innerWidth <= 820;
  const loadBudget = () => (isMobile() ? 10000 : 6000);

  // Every film is downloaded into memory once, as soon as the page opens, so the arms can
  // pop up the moment a specimen is clicked. Until a film has arrived it streams from its URL.
  const filmBlobs = new Map();   // film path -> object URL
  const preload = { parts: new Map(), films: new Map(), listeners: new Set(), promise: null };

  function preloadProgress() {
    const parts = [...preload.parts.values()];
    return parts.length ? parts.reduce((sum, p) => sum + p, 0) / parts.length : 1;
  }

  function reportPreload(key, fraction) {
    preload.parts.set(key, fraction);
    const p = preloadProgress();
    preload.listeners.forEach((fn) => fn(p));
  }

  async function fetchFilm(url) {
    reportPreload(url, 0);
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total) reportPreload(url, Math.min(loaded / total, 0.99));
      }
      filmBlobs.set(url, URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })));
    } catch (e) {
      // offline, or opened straight from disk: the film streams when it is opened instead
    }
    reportPreload(url, 1);
  }

  function startPreload() {
    if (preload.promise) return preload.promise;
    reportPreload('plate', 0);
    const plateImg = new Image();
    plateImg.src = window.PLATE.src;
    const plateReady = plateImg.decode().catch(() => {}).then(() => reportPreload('plate', 1));
    const urls = [...new Set(items.filter((it) => it.film).map((it) => it.film))];
    urls.forEach((url) => preload.films.set(url, fetchFilm(url)));
    preload.promise = Promise.all([plateReady, ...preload.films.values()]);
    return preload.promise;
  }

  /* ─── Film helpers ────────────────────────────────────────── */

  const filmSrc = (it) => filmBlobs.get(it.film) || it.film;

  function prefetchFilm(it) {
    const src = filmSrc(it);
    if (film.dataset.src === src) return;
    film.preload = 'auto';
    film.src = src;
    film.dataset.src = src;
  }

  function filmReady(it) {
    prefetchFilm(it);
    if (film.readyState >= 4) return Promise.resolve();
    if (film.networkState === film.NETWORK_IDLE && film.readyState < 2) film.load();
    return new Promise((resolve) => {
      const done = () => {
        film.removeEventListener('canplaythrough', done);
        film.removeEventListener('error', done);
        resolve();
      };
      film.addEventListener('canplaythrough', done);
      film.addEventListener('error', done);
    });
  }

  // wait (within the load budget) until the film can play through without stalling
  async function waitForFilm(it) {
    const deadline = wait(loadBudget());
    const pending = preload.films.get(it.film);
    if (pending && !filmBlobs.has(it.film)) await Promise.race([pending, deadline]);
    await Promise.race([filmReady(it), deadline]);
  }

  // show the quiet 'Loading film' line only if the wait is noticeable
  async function withLoader(promise, t) {
    const timer = setTimeout(() => { if (t === token) filmLoader.classList.add('is-shown'); }, 250);
    await promise;
    clearTimeout(timer);
    filmLoader.classList.remove('is-shown');
  }

  async function raiseArms() {
    rig.getAnimations().forEach((a) => a.cancel());
    film.currentTime = 0;
    film.muted = !soundOn;
    try {
      await film.play();
    } catch (e) {
      film.muted = true;
      try { await film.play(); } catch (err) { /* nothing more to try */ }
    }
    // up from below the bottom edge, overshooting slightly as if pushed out of the screen
    const rise = rig.animate([
      { transform: 'translate(-50%, 106%) scale(1.1)', easing: 'cubic-bezier(.18,.9,.32,1)' },
      { transform: 'translate(-50%, -3.2%) scale(1.015)', offset: 0.64, easing: 'cubic-bezier(.45,0,.4,1)' },
      { transform: 'translate(-50%, 0) scale(1)' },
    ], { duration: T(1250), fill: 'forwards' });
    await settled(rise);
  }

  async function sinkArms() {
    if (film.ended) {
      // already faded out at the end of the film: just park the rig below the edge
      rig.getAnimations().forEach((a) => a.cancel());
      return;
    }
    const from = getComputedStyle(rig).transform;
    rig.getAnimations().forEach((a) => a.cancel());
    const sink = rig.animate([
      { transform: from === 'none' ? 'translate(-50%, 106%)' : from },
      { transform: 'translate(-50%, 106%) scale(1.04)' },
    ], { duration: T(460), easing: 'cubic-bezier(.55,0,.8,.4)', fill: 'forwards' });
    await settled(sink);
    film.pause();
  }

  // where the hands hold the material once the arms are up
  function heldRect(it) {
    const rw = rig.offsetWidth;
    const rh = rig.offsetHeight;
    const left = (innerWidth - rw) / 2;
    const top = innerHeight - rh;
    const c = it.shape.cut;
    const w = rw * 0.22;
    const h = (w * c.h) / c.w;
    return { left: left + rw * 0.485 - w / 2, top: top + rh * 0.5 - h / 2, width: w, height: h };
  }

  // never leave a film's last frame standing on the page (an export can end on an opaque frame)
  film.addEventListener('ended', () => {
    rig.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T(350), easing: 'ease-out', fill: 'forwards' });
  });

  /* ─── The flyer: carries a specimen between plate and slide ── */

  // An element's box as the flyer sees it. On the turned plate a specimen lies on its side,
  // so hand over the upright box with a quarter turn the flyer can unwind in flight.
  function rectOf(node) {
    const r = node.getBoundingClientRect();
    if (node instanceof SVGElement && rotatedQuery.matches) {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return { left: cx - r.height / 2, top: cy - r.width / 2, width: r.height, height: r.width, rot: 90 };
    }
    return { left: r.left, top: r.top, width: r.width, height: r.height, rot: 0 };
  }

  function placeFlyer(r) {
    flyer.style.left = `${r.left}px`;
    flyer.style.top = `${r.top}px`;
    flyer.style.width = `${r.width}px`;
    flyer.style.height = `${r.height}px`;
    flyerRect = { left: r.left, top: r.top, width: r.width, height: r.height, rot: r.rot || 0 };
  }

  function launchFlyer(it, r) {
    flyer.getAnimations().forEach((a) => a.cancel());
    flyer.src = it.shape.cut.src;
    placeFlyer(r);
    flyer.classList.add('is-flying');
  }

  // transforms are about the flyer's centre, so a quarter turn unwinds in place
  function flyTo(target, duration = 860) {
    const a = flyerRect;
    placeFlyer(target);
    const dx = (a.left + a.width / 2) - (target.left + target.width / 2);
    const dy = (a.top + a.height / 2) - (target.top + target.height / 2);
    const sx = a.width / target.width;
    const sy = a.height / target.height;
    const ra = a.rot || 0;
    const rt = target.rot || 0;
    const mid = (from, to) => from + (to - from) * 0.55;
    const anim = flyer.animate([
      { transform: `translate(${dx}px, ${dy}px) rotate(${ra}deg) scale(${sx}, ${sy})` },
      {
        transform: `translate(${mid(dx, 0)}px, ${mid(dy, 0) - 26}px) rotate(${mid(ra, rt)}deg) scale(${mid(sx, 1) * 1.05}, ${mid(sy, 1) * 1.05})`,
        offset: 0.5,
      },
      { transform: `rotate(${rt}deg)` },
    ], { duration: T(duration), easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' });
    return settled(anim);
  }

  function dropFlyer() {
    const fall = innerHeight - flyerRect.top + 60;
    const anim = flyer.animate([
      { transform: 'none' },
      { transform: `translateY(${fall}px) rotate(9deg) scale(1.08)` },
    ], { duration: T(460), easing: 'cubic-bezier(.55,0,.85,.35)', fill: 'forwards' });
    return settled(anim).then(hideFlyer);
  }

  function hideFlyer() {
    flyer.classList.remove('is-flying');
    flyer.getAnimations().forEach((a) => a.cancel());
  }

  // every transition starts here: bump the token so stale async steps bail out,
  // and clear the flyer an interrupted transition may have left in mid-air
  function begin() {
    hideFlyer();
    filmLoader.classList.remove('is-shown');
    settingUp = false;
    cover.classList.remove('is-setting-up');
    return ++token;
  }

  /* ─── Specimen slide ──────────────────────────────────────── */

  const stackedQuery = matchMedia('(max-width: 820px), (max-aspect-ratio: 6/5)');

  function stageRect(it) {
    const c = it.shape.cut;
    const small = stackedQuery.matches;
    const maxW = innerWidth * (small ? 0.7 : 0.36);
    const maxH = innerHeight * (small ? 0.34 : 0.56);
    const s = Math.min(maxW / c.w, maxH / c.h, 1.8);
    const w = c.w * s;
    const h = c.h * s;
    const cx = innerWidth / 2;
    const cy = innerHeight * (small ? 0.74 : 0.55);
    return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
  }

  function placeStage(it) {
    const r = stageRect(it);
    stageImg.style.left = `${r.left}px`;
    stageImg.style.top = `${r.top}px`;
    stageImg.style.width = `${r.width}px`;
    stageImg.style.height = `${r.height}px`;
    return r;
  }

  function fill(it) {
    $('detail-no').textContent = `Specimen No. ${pad(it.n)}`;
    $('detail-name').textContent = it.name;
    $('nav-count').textContent = `${pad(it.n)} / ${pad(items.length)}`;
    $('desc-text').textContent = it.text || 'Description to come.';
    const meta = $('desc-meta');
    meta.replaceChildren();
    if (it.label) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = 'Tape label';
      dd.textContent = it.label;
      meta.append(dt, dd);
    }
    $('desc-controls').hidden = !it.film;
    stageImg.src = it.shape.cut.src;
    stageImg.alt = it.name;
    document.title = `${it.name} — Biomaterial Samplebook`;
  }

  function resetStage() {
    desc.classList.remove('is-shown');
    stageImg.classList.remove('is-shown', 'is-floating');
    stageImg.getAnimations().forEach((a) => a.cancel());
    rig.getAnimations().forEach((a) => a.cancel());
    film.pause();
  }

  function landOnStage(it) {
    placeStage(it);
    stageImg.classList.add('is-shown', 'is-floating');
    hideFlyer();
  }

  async function popStage(it) {
    placeStage(it);
    stageImg.classList.add('is-shown');
    await settled(stageImg.animate([
      { opacity: 0, transform: 'translateY(60px) scale(0.92)' },
      { opacity: 1, transform: 'none' },
    ], { duration: T(760), easing: 'cubic-bezier(.3,1.3,.45,1)' }));
    stageImg.classList.add('is-floating');
  }

  async function present(it, t, from) {
    current = it;
    fill(it);
    resetStage();
    requestAnimationFrame(() => detail.classList.add('is-in'));

    if (it.film) {
      const loading = waitForFilm(it); // runs during the flight
      if (from) {
        launchFlyer(it, from);
        await flyTo(heldRect(it), 820);
        if (t !== token) return;
        await withLoader(loading, t);
        if (t !== token) return;
        dropFlyer();
        await wait(T(140));
      } else {
        await withLoader(loading, t);
      }
      if (t !== token) return;
      await raiseArms();
      if (t !== token) return;
      await wait(T(180));
    } else if (from) {
      launchFlyer(it, from);
      await flyTo(stageRect(it));
      if (t !== token) return;
      landOnStage(it);
      await wait(T(120));
    } else {
      await popStage(it);
    }
    if (t !== token) return;
    desc.classList.add('is-shown'); // the arms are out: bring in the description
  }

  async function enterDetail(it, from) {
    const t = begin();
    view = 'detail';
    setView('detail');
    await present(it, t, from);
    if (t === token) clearHover();
  }

  async function switchSpecimen(it) {
    const t = begin();
    desc.classList.remove('is-shown');
    detail.classList.remove('is-in');
    if (current && current.film) {
      await sinkArms();
    } else {
      await settled(stageImg.animate(
        [{ opacity: 1 }, { opacity: 0, transform: 'translateY(30px) scale(0.96)' }],
        { duration: T(260), easing: 'ease-in', fill: 'forwards' },
      ));
    }
    if (t !== token) return;
    await present(it, t, null);
  }

  async function leaveDetail() {
    const t = begin();
    const it = current;
    view = 'library';
    desc.classList.remove('is-shown');
    detail.classList.remove('is-in');
    document.title = 'Biomaterial Samplebook';
    if (!it) { setView('library'); return; }

    // on a phone the plate can be scrolled: bring the specimen's spot back into view first
    if (library.scrollHeight > library.clientHeight) it.cut.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const home = rectOf(it.cut);
    if (it.film) {
      await sinkArms();
      if (t !== token) return;
      // hand the specimen back up from the bottom edge
      launchFlyer(it, { left: innerWidth / 2 - home.width, top: innerHeight + 30, width: home.width * 2, height: home.height * 2 });
    } else {
      launchFlyer(it, rectOf(stageImg));
      stageImg.classList.remove('is-shown', 'is-floating');
    }
    setView('library');
    await flyTo(home, 760);
    if (t !== token) return;
    hideFlyer();
    current = null;
    if (keyboardUser) it.hit.focus({ preventScroll: true });
  }

  function open(it) {
    if (view !== 'library') return;
    pendingFlight = { it, rect: rectOf(it.cut) };
    go(`#/specimen/${pad(it.n)}`);
  }

  function step(dir) {
    if (!current) return;
    const next = items[(current.n - 1 + dir + items.length) % items.length];
    go(`#/specimen/${pad(next.n)}`);
  }

  // First time through: the cover holds while the films download, then lifts onto the library
  async function setUpLibrary(t) {
    settingUp = true;
    cover.classList.add('is-setting-up');
    const show = (p) => {
      setupFill.style.transform = `scaleX(${p})`;
      setupPct.textContent = `${Math.round(p * 100)}%`;
    };
    show(preloadProgress());
    preload.listeners.add(show);
    const started = performance.now();
    await Promise.race([startPreload(), wait(loadBudget())]);
    const shown = performance.now() - started;
    if (shown < 1200) await wait(T(1200 - shown)); // long enough to read as a step, not a flicker
    preload.listeners.delete(show);
    if (t !== token) return;
    await wait(T(300));
    if (t !== token) return;
    settingUp = false;
    libraryReady = true;
    view = 'library';
    setView('library');
    setTimeout(hint, 750);
    setTimeout(() => { if (view !== 'cover') cover.classList.remove('is-setting-up'); }, 1100);
  }

  /* ─── Views and routing ───────────────────────────────────── */

  function setView(v) {
    body.dataset.view = v;
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function parse() {
    const m = location.hash.match(/^#\/specimen\/(\d+)$/);
    if (m && items[Number(m[1]) - 1]) return { view: 'detail', it: items[Number(m[1]) - 1] };
    if (location.hash === '#/library') return { view: 'library' };
    return { view: 'cover' };
  }

  function route() {
    const next = parse();
    const flight = pendingFlight;
    pendingFlight = null;

    if (next.view === 'detail') {
      if (view === 'detail') {
        if (next.it !== current) switchSpecimen(next.it);
      } else {
        const from = flight && flight.it === next.it && view === 'library' ? flight.rect : null;
        enterDetail(next.it, from);
      }
      return;
    }

    if (next.view === 'library') {
      if (settingUp) return;
      if (view === 'detail') {
        leaveDetail();
      } else if (view === 'cover' && !libraryReady) {
        setUpLibrary(begin());
      } else {
        begin();
        const fromCover = view === 'cover';
        view = 'library';
        setView('library');
        setTimeout(hint, fromCover ? 750 : 150);
      }
      return;
    }

    begin();
    resetStage();
    view = 'cover';
    current = null;
    clearHover();
    detail.classList.remove('is-in');
    document.title = 'Biomaterial Samplebook';
    setView('cover');
  }

  /* ─── Controls ────────────────────────────────────────────── */

  $('cover-open').addEventListener('click', () => go('#/library'));
  $('to-cover').addEventListener('click', () => go('#/'));
  $('back').addEventListener('click', () => go('#/library'));
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));

  $('replay').addEventListener('click', async () => {
    if (!current || !current.film) return;
    const t = begin();
    desc.classList.remove('is-shown');
    await sinkArms();
    if (t !== token) return;
    await raiseArms();
    if (t === token) desc.classList.add('is-shown');
  });

  function renderSound() {
    soundBtn.textContent = soundOn ? 'Sound on' : 'Sound off';
    soundBtn.setAttribute('aria-pressed', String(soundOn));
  }
  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    film.muted = !soundOn;
    try { localStorage.setItem('samplebook-sound', soundOn ? 'on' : 'off'); } catch (e) { /* ignore */ }
    renderSound();
  });
  renderSound();

  // the cover also opens on scroll / swipe
  $('cover').addEventListener('wheel', (e) => {
    if (view === 'cover' && e.deltaY > 12) go('#/library');
  }, { passive: true });
  let touchY = null;
  $('cover').addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  $('cover').addEventListener('touchend', (e) => {
    if (touchY !== null && touchY - e.changedTouches[0].clientY > 40) go('#/library');
    touchY = null;
  });

  document.addEventListener('keydown', (e) => {
    keyboardUser = true;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (view === 'cover' && ['ArrowDown', 'ArrowRight', 'PageDown'].includes(e.key)) go('#/library');
    else if (view === 'detail') {
      if (e.key === 'Escape') go('#/library');
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    } else if (view === 'library' && e.key === 'Escape') go('#/');
  });
  document.addEventListener('pointerdown', () => { keyboardUser = false; });

  addEventListener('hashchange', route);
  addEventListener('resize', () => {
    if (view === 'detail' && current && !current.film && stageImg.classList.contains('is-shown')) placeStage(current);
  });

  startPreload();
  route();
})();
