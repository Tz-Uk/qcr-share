/**
 * ArcView — the renderer.
 *
 * All 6,236 verses sit on one axis; every cross-reference is a half-ellipse
 * between two of them. The map is drawn as additive hairlines into an
 * off-screen buffer and tone-mapped, so a lone link is visible and dense areas
 * deepen in colour instead of clipping to white.
 *
 * Performance model:
 *  - The WebGL pass (65k hairlines) runs only when the camera settles.
 *  - Zoom and pan move the already-rendered canvas with a CSS transform, on the
 *    compositor. No WebGL work happens on animation frames.
 *  - On every render, links whose ends both leave the window are dropped and
 *    the buffer is capped to a detail budget, so a zoomed view uploads hundreds
 *    of links, not 65,000.
 *  - The overlay (axis, labels, focused links) is cheap 2D and stays live.
 */

import { state, posOf, verseAtPos, refOf, surahEnvelope, verseEnvelope } from './data.js';

const MIN_SPAN = 6;
const TOTAL = 6236;
const LINE_SEGMENTS = 48;
const TAU = Math.PI * 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/* ------------------------------------------------------------------ shaders */

const LINE_VERT = `#version 300 es
precision highp float;

in vec4 aTrig;       // cos(pi t), sin(pi t), t
in vec2 aEnds;
in vec2 aGenres;
in float aWeight;

uniform vec2 uViewport;
uniform float uViewStart;
uniform float uViewEnd;
uniform float uMargin;
uniform float uAxisStart;
uniform float uAxisEnd;
uniform float uBaseline;
uniform float uMaxHeight;
uniform float uAlpha;
uniform vec3 uC0;
uniform vec3 uC1;

out vec4 vColor;

void main() {
  float span = max(1.0, uViewEnd - uViewStart);
  float ax = uAxisStart + (aEnds.x - uViewStart) / span * (uAxisEnd - uAxisStart);
  float bx = uAxisStart + (aEnds.y - uViewStart) / span * (uAxisEnd - uAxisStart);

  bool offLeft  = aEnds.x < uViewStart - uMargin && aEnds.y < uViewStart - uMargin;
  bool offRight = aEnds.x > uViewEnd + uMargin && aEnds.y > uViewEnd + uMargin;
  if (offLeft || offRight) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec4(0.0);
    return;
  }

  float radius = 0.5 * (bx - ax);
  float height = min(abs(radius), uMaxHeight);
  float x = 0.5 * (ax + bx) - radius * aTrig.x;
  float y = uBaseline - height * aTrig.y;

  gl_Position = vec4(x / uViewport.x * 2.0 - 1.0, 1.0 - y / uViewport.y * 2.0, 0.0, 1.0);

  vec3 c1 = mix(uC0, uC1, aGenres.x);
  vec3 c2 = mix(uC0, uC1, aGenres.y);
  vec3 colour = mix(c1, c2, aTrig.z);
  vColor = vec4(colour * uAlpha * aWeight, 0.0);
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

const COMPOSITE_VERT = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAccum;
uniform float uCeiling;
uniform float uDim;
out vec4 outColor;
void main() {
  vec3 light = texture(uAccum, vUv).rgb;
  float peak = max(max(light.r, light.g), light.b);
  // Reinhard tone map: one divide, no per-pixel logarithm.
  float intensity = clamp(peak / (peak + max(1.0, uCeiling) * 0.042), 0.0, 1.0) * uDim;
  vec3 hue = peak > 0.0 ? light / peak : vec3(0.0);
  outColor = vec4(hue, intensity);
}`;

/* --------------------------------------------------------------------- view */

export class ArcView {
  constructor(canvas, { onHover, onSelect, onSurah } = {}) {
    this.canvas = canvas;
    this.overlay = document.getElementById('overlay');
    this.octx = this.overlay.getContext('2d');
    this.minimap = document.getElementById('minimap');
    this.miniwin = document.getElementById('miniwin');
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onSurah = onSurah || (() => {});

    this.w = 0; this.h = 0; this.dpr = 1; this.odpr = 1;
    this.pad = 18;
    this.base = 0;
    this.cam = { start: 0, end: TOTAL };
    this.selected = null;
    this.hovered = null;
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.moved = 0;

    this.anim = null;
    this._raf = 0;
    this._glowDirty = true;
    this._settleAt = 0;
    this._renderTimer = 0;
    this.glowCam = null;
    this.linkOrder = null;

    this.focusAlpha = 1;
    this._focusFadeAt = 0;
    this._pulseAt = 0;
    this.surahPreview = null;
    this._surahPreviewAt = 0;
    this.labelRects = [];

    this._palette = null;
    this._themeStamp = '';

    this.gl = null;
    try {
      this.gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
    } catch { this.gl = null; }

    this.isGL = !!this.gl;
    this.instanceCount = 0;
    this.ceiling = 84;

    if (this.isGL) this._initGL();
    else this._init2D();

    this._bind();
    this._bindMinimap();
    this.resize();
  }

  /* --------------------------------------------------------------- WebGL */

  _compile(type, source) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
    }
    return sh;
  }

  _program(vert, frag) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vert));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    }
    return p;
  }

  _initGL() {
    const gl = this.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.glRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL2';
    this.softwareGL = /swiftshader|llvmpipe|software|basic render/i.test(String(this.glRenderer));

    this.lineProgram = this._program(LINE_VERT, LINE_FRAG);
    this.lineLoc = {
      aTrig: gl.getAttribLocation(this.lineProgram, 'aTrig'),
      aEnds: gl.getAttribLocation(this.lineProgram, 'aEnds'),
      aGenres: gl.getAttribLocation(this.lineProgram, 'aGenres'),
      aWeight: gl.getAttribLocation(this.lineProgram, 'aWeight'),
      uViewport: gl.getUniformLocation(this.lineProgram, 'uViewport'),
      uViewStart: gl.getUniformLocation(this.lineProgram, 'uViewStart'),
      uViewEnd: gl.getUniformLocation(this.lineProgram, 'uViewEnd'),
      uMargin: gl.getUniformLocation(this.lineProgram, 'uMargin'),
      uAxisStart: gl.getUniformLocation(this.lineProgram, 'uAxisStart'),
      uAxisEnd: gl.getUniformLocation(this.lineProgram, 'uAxisEnd'),
      uBaseline: gl.getUniformLocation(this.lineProgram, 'uBaseline'),
      uMaxHeight: gl.getUniformLocation(this.lineProgram, 'uMaxHeight'),
      uAlpha: gl.getUniformLocation(this.lineProgram, 'uAlpha'),
      uC0: gl.getUniformLocation(this.lineProgram, 'uC0'),
      uC1: gl.getUniformLocation(this.lineProgram, 'uC1'),
    };

    const tVerts = new Float32Array(LINE_SEGMENTS * 2 * 4);
    for (let s = 0; s < LINE_SEGMENTS; s++) {
      const a = s / LINE_SEGMENTS;
      const b = (s + 1) / LINE_SEGMENTS;
      tVerts.set([
        Math.cos(Math.PI * a), Math.sin(Math.PI * a), a, 0,
        Math.cos(Math.PI * b), Math.sin(Math.PI * b), b, 0,
      ], s * 8);
    }
    this.lineVerts = LINE_SEGMENTS * 2;

    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    this.tBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tBuf);
    gl.bufferData(gl.ARRAY_BUFFER, tVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.lineLoc.aTrig);
    gl.vertexAttribPointer(this.lineLoc.aTrig, 4, gl.FLOAT, false, 0, 0);

    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(8), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.lineLoc.aEnds);
    gl.vertexAttribPointer(this.lineLoc.aEnds, 2, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(this.lineLoc.aEnds, 1);
    gl.enableVertexAttribArray(this.lineLoc.aGenres);
    gl.vertexAttribPointer(this.lineLoc.aGenres, 2, gl.FLOAT, false, 20, 8);
    gl.vertexAttribDivisor(this.lineLoc.aGenres, 1);
    gl.enableVertexAttribArray(this.lineLoc.aWeight);
    gl.vertexAttribPointer(this.lineLoc.aWeight, 1, gl.FLOAT, false, 20, 16);
    gl.vertexAttribDivisor(this.lineLoc.aWeight, 1);
    gl.bindVertexArray(null);

    this.compProgram = this._program(COMPOSITE_VERT, COMPOSITE_FRAG);
    this.compLoc = {
      aPos: gl.getAttribLocation(this.compProgram, 'aPos'),
      uAccum: gl.getUniformLocation(this.compProgram, 'uAccum'),
      uCeiling: gl.getUniformLocation(this.compProgram, 'uCeiling'),
      uDim: gl.getUniformLocation(this.compProgram, 'uDim'),
    };
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.compLoc.aPos);
    gl.vertexAttribPointer(this.compLoc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.glowTex = gl.createTexture();
    this.glowFbo = gl.createFramebuffer();
    this._allocGlow(this.canvas.width || 1, this.canvas.height || 1);

    this.canvas.style.transformOrigin = '0 0';
  }

  _allocGlow(w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.glowTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0,
      this.floatTargets ? gl.RGBA16F : gl.RGBA8,
      w, h, 0, gl.RGBA,
      this.floatTargets ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.glowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.glowTex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok && this.floatTargets) {
      this.floatTargets = false;
      this._allocGlow(w, h);
    }
  }

  _init2D() {
    this.ctx = this.canvas.getContext('2d');
    this.scene = document.createElement('canvas');
    this.sctx = this.scene.getContext('2d');
    this.overlay.style.display = 'none';
    this.softwareGL = false;
    this.glRenderer = 'Canvas2D fallback';
  }

  /* ----------------------------------------------------------- data/lifecycle */

  rebuildInstances() {
    this.linkOrder = null;
    this.glowCam = null;
    this._glowDirty = true;
    this._settleAt = 0;
    this.schedule();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssDpr = Math.min(window.devicePixelRatio || 1, 2);
    const glDpr = this.isGL
      ? (this.softwareGL ? 0.5 : Math.min(cssDpr, 1.25))
      : cssDpr;
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.dpr = glDpr;
    this.odpr = cssDpr;
    this.canvas.width = Math.round(this.w * glDpr);
    this.canvas.height = Math.round(this.h * glDpr);
    this.overlay.width = Math.round(this.w * cssDpr);
    this.overlay.height = Math.round(this.h * cssDpr);

    if (this.isGL) {
      this._allocGlow(this.canvas.width, this.canvas.height);
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    } else {
      this.ctx.setTransform(cssDpr, 0, 0, cssDpr, 0, 0);
      this.scene.width = this.canvas.width;
      this.scene.height = this.canvas.height;
      this.sctx.setTransform(cssDpr, 0, 0, cssDpr, 0, 0);
      this._glowDirty = true;
    }
    this.octx.setTransform(cssDpr, 0, 0, cssDpr, 0, 0);
    this.base = this.h - Math.max(64, Math.min(96, this.h * 0.14));
    this.pad = this.w < 600 ? 10 : 18;
    this.glowCam = null;
    this._glowDirty = true;
    this._settleAt = 0;
    this.schedule();
  }

  invalidate(glow = true) {
    if (glow) this._glowDirty = true;
    this.schedule();
  }

  /** A camera change that is still in progress: move the cached image, render later. */
  _interact(ms = 150) {
    this._glowDirty = true;
    this._settleAt = performance.now() + ms;
    clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => {
      this._settleAt = 0;
      this.schedule();
    }, ms);
    this.schedule();
  }

  schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame((now) => {
      this._raf = 0;
      this._tick(now);
      this.draw();
      if (this.anim) this.schedule();
    });
  }

  /* -------------------------------------------------------------- camera */

  get span() { return this.cam.end - this.cam.start; }
  get plotW() { return Math.max(1, this.w - this.pad * 2); }

  xOf(pos) {
    return this.pad + ((pos - this.cam.start) / this.span) * this.plotW;
  }

  posAt(x) {
    return this.cam.start + ((x - this.pad) / this.plotW) * this.span;
  }

  setCamera(start, end, { animate = false, ms = 420 } = {}) {
    const span = clamp(end - start, MIN_SPAN, TOTAL);
    start = clamp(start, 0, TOTAL - span);
    const target = { start, end: start + span };
    if (animate) {
      this.anim = { from: { ...this.cam }, to: target, t0: performance.now(), ms };
      this._glowDirty = true;
      this._settleAt = Infinity;
      this.schedule();
    } else {
      this.anim = null;
      this.cam = target;
      this._interact(150);
    }
  }

  _tick(now) {
    if (!this.anim) return false;
    const a = this.anim;
    let k = (now - a.t0) / a.ms;
    if (!Number.isFinite(k) || k < 0) k = 0;
    if (k >= 1) {
      k = 1;
      this.anim = null;
      this._settleAt = 0;
      this._glowDirty = true;
    }
    const e = easeInOut(k);
    this.cam.start = a.from.start + (a.to.start - a.from.start) * e;
    this.cam.end = a.from.end + (a.to.end - a.from.end) * e;
    return true;
  }

  zoomAt(x, factor) {
    this.anim = null;
    const anchor = this.posAt(x);
    const span = clamp(this.span / factor, MIN_SPAN, TOTAL);
    const ratio = (anchor - this.cam.start) / this.span;
    this.setCamera(anchor - ratio * span, anchor - ratio * span + span);
  }

  animateZoom(factor, ms = 300) {
    const anchor = this.cam.start + this.span / 2;
    const span = clamp(this.span / factor, MIN_SPAN, TOTAL);
    this.setCamera(anchor - span / 2, anchor + span / 2, { animate: true, ms });
  }

  focusPos(start, end, { animate = true } = {}) {
    const span = clamp(end - start, MIN_SPAN, TOTAL);
    start = clamp(start, 0, TOTAL - span);
    this.setCamera(start, start + span, { animate });
  }

  /**
   * Fit a surah. If its whole connection envelope is reasonably tight, fit
   * that; otherwise fit the surah itself and leave the far links to the
   * explicit "Fit all links" action. Fitting every global link would just
   * return to the whole Quran for 107 of 114 surahs.
   */
  fitSurah(number, { all = true } = {}) {
    const s = state.quran.surahs[number - 1];
    const env = s ? surahEnvelope(number) : null;
    if (!s || !env) return { all: false, span: 0 };

    const surahLo = posOf(s.start);
    const surahHi = posOf(s.start + s.verses - 1);
    const surahSpan = Math.max(1, surahHi - surahLo);
    const envSpan = env.end - env.start;
    const fitsAll = envSpan <= Math.max(900, surahSpan * 2.5);

    if (all || fitsAll) {
      const pad = Math.max(0, (24 - envSpan) / 2);
      this.focusPos(env.start - pad, env.end + pad);
      return { all: true, span: envSpan };
    }

    const target = Math.max(24, surahSpan * 1.15);
    const centre = (surahLo + surahHi) / 2;
    this.focusPos(centre - target / 2, centre + target / 2);
    return { all: false, span: envSpan };
  }

  /** Fit a verse together with every verse it connects to. */
  fitVerseConnections(index) {
    const env = verseEnvelope(index);
    this.focusPos(env.start, env.end);
  }

  focusVerse(index, { zoom = true, animate = true } = {}) {
    const p = posOf(index);
    if (zoom) {
      const span = 34;
      this.setCamera(p - span / 2, p + span / 2, { animate });
    } else if (p < this.cam.start + 2 || p > this.cam.end - 2) {
      this.setCamera(p - 60, p + 60, { animate });
    }
    this.setSelected(index);
  }

  setSelected(index) {
    this.selected = index;
    this.focusAlpha = 0;
    this._focusFadeAt = performance.now();
    this._pulseAt = performance.now();
    this.invalidate(false);
  }

  setHovered(index) {
    if (this.hovered === index) return;
    this.hovered = index;
    if (this.selected == null) {
      this.focusAlpha = 0;
      this._focusFadeAt = performance.now();
    }
    this.invalidate(false);
  }

  /* -------------------------------------------------------------- events */

  _bind() {
    const c = this.canvas;

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.anim = null;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.045 : 0.0016));
      this.zoomAt(x, factor);
      this._notifyHover(x, e.clientY - rect.top);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      this.anim = null;
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.drag = { x: e.clientX, cam: { ...this.cam } };
        this.moved = 0;
      } else if (this.pointers.size === 2) {
        this.drag = null;
        const [a, b] = [...this.pointers.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cam: { ...this.cam } };
      }
      this._interact(160);
    });

    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (this.pointers.size === 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch.dist > 0) {
          const factor = dist / this.pinch.dist;
          const midX = (a.x + b.x) / 2 - rect.left;
          const cam = this.pinch.cam;
          const anchor = cam.start + ((midX - this.pad) / this.plotW) * (cam.end - cam.start);
          const span = clamp((cam.end - cam.start) / factor, MIN_SPAN, TOTAL);
          const ratio = (anchor - cam.start) / (cam.end - cam.start);
          this.cam = { start: anchor - ratio * span, end: anchor - ratio * span + span };
          this._interact(170);
        }
        this._notifyHover(px, py);
        return;
      }

      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        this.moved = Math.max(this.moved, Math.abs(dx));
        const span = this.drag.cam.end - this.drag.cam.start;
        const shift = (-dx / this.plotW) * span;
        this.cam = {
          start: clamp(this.drag.cam.start + shift, 0, TOTAL - span),
          end: clamp(this.drag.cam.end + shift, span, TOTAL),
        };
        this._interact(170);
      }

      this._notifyHover(px, py);
    });

    const end = (e) => {
      const had = this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.drag && had && this.moved < 5) {
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const label = this.labelRects.find(
          (r) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2,
        );
        if (label) {
          this.onSurah(label.n);
        } else if (y < this.base - 8) {
          // The field is surah navigation; the axis is verse selection.
          const pos = clamp(Math.round(this.posAt(x)), 0, TOTAL - 1);
          this.onSurah(state.quran.verses[verseAtPos(pos)].s);
        } else {
          const pos = clamp(Math.round(this.posAt(x)), 0, TOTAL - 1);
          this.onSelect(verseAtPos(pos));
        }
      }
      if (this.pointers.size === 0) {
        this.drag = null;
        this._interact(90);
      }
    };

    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (!this.drag) this._notifyHover(-1, -1);
    });

    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      this.zoomAt(e.clientX - rect.left, 4);
    });
  }

  _bindMinimap() {
    const map = this.minimap;
    if (!map) return;
    const jump = (e) => {
      const r = map.getBoundingClientRect();
      const p = clamp((e.clientX - r.left) / r.width, 0, 1) * TOTAL;
      const span = this.span;
      this.setCamera(p - span / 2, p - span / 2 + span);
    };
    let dragging = false;
    map.addEventListener('pointerdown', (e) => {
      dragging = true;
      map.setPointerCapture(e.pointerId);
      jump(e);
    });
    map.addEventListener('pointermove', (e) => { if (dragging) jump(e); });
    map.addEventListener('pointerup', () => { dragging = false; });
    map.addEventListener('pointercancel', () => { dragging = false; });
  }

  _notifyHover(px, py) {
    if (px < 0 || py < 0) {
      this.setHovered(null);
      this.onHover(null);
      return;
    }
    const label = this.labelRects.find(
      (r) => px >= r.x1 && px <= r.x2 && py >= r.y1 && py <= r.y2,
    );
    if (label) {
      this.setHovered(null);
      this.onHover(null);
      this.canvas.style.cursor = 'pointer';
      return;
    }
    if (py < this.base - 8) {
      const pos = clamp(Math.round(this.posAt(px)), 0, TOTAL - 1);
      const s = state.quran.surahs[state.quran.verses[verseAtPos(pos)].s - 1];
      this.setHovered(null);
      this.onHover({ surah: s, x: px, y: this.base });
      this.canvas.style.cursor = 'pointer';
      return;
    }
    this.canvas.style.cursor = 'crosshair';
    const pos = clamp(Math.round(this.posAt(px)), 0, TOTAL - 1);
    const index = verseAtPos(pos);
    this.setHovered(index);
    this.onHover({ index, x: this.xOf(posOf(index)), y: this.base });
  }

  setSurahPreview(number) {
    if (number == null) {
      this.surahPreview = null;
      this.schedule();
      return;
    }
    const s = state.quran.surahs[number - 1];
    if (!s) return;
    this.surahPreview = { start: s.start, verses: s.verses, name: s.name };
    this._surahPreviewAt = performance.now();
    this.schedule();
  }

  /* ------------------------------------------------------------- palette */

  palette() {
    const stamp = document.documentElement.dataset.theme || 'dark';
    if (this._palette && this._themeStamp === stamp) return this._palette;
    const cs = getComputedStyle(document.documentElement);
    const hex = (name, fallback) => hexToRgb(cs.getPropertyValue(name).trim() || fallback);
    this._palette = {
      meccan: hex('--mm', '#2dd4bf'),
      medinan: hex('--dd', '#f5a524'),
      accent: hex('--accent', '#e6c17c'),
      sel: hex('--sel', '#f3e2bb'),
      ink: hex('--ink', '#ffffff'),
      mutedHex: cs.getPropertyValue('--muted').trim() || '#888888',
      line: cs.getPropertyValue('--line-2').trim() || 'rgba(255,255,255,.15)',
      accentCss: cs.getPropertyValue('--accent').trim() || '#e6c17c',
      meccanCss: cs.getPropertyValue('--mm').trim() || '#2dd4bf',
      medinanCss: cs.getPropertyValue('--dd').trim() || '#f5a524',
      selCss: cs.getPropertyValue('--sel').trim() || '#f3e2bb',
      inkCss: cs.getPropertyValue('--ink').trim() || '#ffffff',
    };
    this._themeStamp = stamp;
    return this._palette;
  }

  /* ------------------------------------------------------------- drawing */

  draw() {
    if (!state.quran) return;
    const now = performance.now();
    const interacting = !!(this.anim || this.drag || this.pinch) || now < this._settleAt;

    if (this.isGL) {
      if (!interacting && (this._glowDirty || !this.glowCam)) this._drawGL();
    } else if (!interacting && (this._glowDirty || !this.glowCam)) {
      this._draw2D();
    }

    this._applyTransform(interacting);
    this._drawOverlay();
  }

  /** Move the rendered canvas to the live camera without touching WebGL. */
  _applyTransform(interacting) {
    if (!this.glowCam) return;
    const sx = clamp((this.glowCam.end - this.glowCam.start) / this.span, 0.0001, 10000);
    const tx = this.pad * (1 - sx) + (this.glowCam.start - this.cam.start) * this.plotW / this.span;
    const extreme = sx > 6 || sx < 1 / 6;

    this.canvas.style.transform = `translateX(${tx}px) scaleX(${sx})`;
    this.canvas.style.opacity = interacting && extreme ? '0.12' : '1';
  }

  _buildInstances() {
    const links = state.links;
    if (!this.linkOrder) {
      this.linkOrder = Array.from({ length: links.length }, (_, i) => i)
        .sort((a, b) => linkHash(a) - linkHash(b));
    }
    const cap = this.softwareGL
      ? (this.span > 3000 ? 12000 : 40000)
      : 65000;
    // Only links fully inside the window plus context belong in the base
    // layer. A focused verse's long links are drawn on the overlay, so this
    // saves thousands of instances at medium zoom without hiding anything the
    // reader is looking at.
    const margin = this.span * 0.15 + 2;
    const pos = state.posOfVerse;
    const verses = state.quran.verses;
    const surahs = state.quran.surahs;
    const cat = state.category;
    const out = [];

    for (const i of this.linkOrder) {
      const l = links[i];
      if (cat >= 0 && l[2] !== cat) continue;
      const pa = pos[l[0]];
      const pb = pos[l[1]];
      if (pa < this.cam.start - margin || pa > this.cam.end + margin) continue;
      if (pb < this.cam.start - margin || pb > this.cam.end + margin) continue;
      const g1 = surahs[verses[l[0]].s - 1].place === 'meccan' ? 0 : 1;
      const g2 = surahs[verses[l[1]].s - 1].place === 'meccan' ? 0 : 1;
      out.push(pos[l[0]], pos[l[1]], g1, g2, 0.75 + 0.25 * Math.min(l[3], 9) / 9);
      if (out.length / 5 >= cap) break;
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.instanceCount = out.length / 5;
    this.ceiling = Math.max(this.instanceCount / 380, 14);
  }

  _drawGL() {
    const gl = this.gl;
    const pal = this.palette();
    const focus = this.selected ?? this.hovered;
    this._buildInstances();

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.glowFbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    if (this.instanceCount && state.linksMode !== 'focus') {
      gl.useProgram(this.lineProgram);
      gl.bindVertexArray(this.lineVao);
      gl.uniform2f(this.lineLoc.uViewport, this.w, this.h);
      gl.uniform1f(this.lineLoc.uViewStart, this.cam.start);
      gl.uniform1f(this.lineLoc.uViewEnd, this.cam.end);
      gl.uniform1f(this.lineLoc.uMargin, this.span * 0.15 + 2);
      gl.uniform1f(this.lineLoc.uAxisStart, this.pad);
      gl.uniform1f(this.lineLoc.uAxisEnd, this.w - this.pad);
      gl.uniform1f(this.lineLoc.uBaseline, this.base);
      gl.uniform1f(this.lineLoc.uMaxHeight, Math.max(20, this.base - 22));
      gl.uniform1f(this.lineLoc.uAlpha, 1.7);
      gl.uniform3fv(this.lineLoc.uC0, pal.meccan);
      gl.uniform3fv(this.lineLoc.uC1, pal.medinan);
      gl.drawArraysInstanced(gl.LINES, 0, this.lineVerts, this.instanceCount);
      gl.bindVertexArray(null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.compProgram);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.glowTex);
    gl.uniform1i(this.compLoc.uAccum, 0);
    gl.uniform1f(this.compLoc.uCeiling, this.ceiling);
    // Keep the all-connections field readable when a verse is open; the gold
    // focus arcs provide the emphasis, not a 70% dim.
    gl.uniform1f(this.compLoc.uDim, focus == null ? 1 : this.selected != null ? 0.78 : 0.92);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    this.glowCam = { ...this.cam };
    this._glowDirty = false;
    this.canvas.style.transform = 'none';
    this.canvas.style.opacity = '1';
  }

  /* ------------------------------------------------- Canvas2D fallback */

  _buildScene() {
    const ctx = this.sctx;
    const pal = this.palette();
    const { base, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    const maxH = Math.max(20, base - 22);
    const span = this.span;
    const alpha = clamp(0.24 * Math.pow(TOTAL / span, 0.32), 0.16, 0.72);
    const width = 0.6 + 0.45 * clamp(1 - span / TOTAL, 0, 1);
    const links = state.links;
    const pos = state.posOfVerse;
    const verses = state.quran.verses;
    const surahs = state.quran.surahs;
    const cat = state.category;
    const cap = span > 3000 ? 12000 : 40000;
    const stride = Math.max(1, Math.ceil(links.length / cap));
    const margin = span * 0.15 + 2;

    const paths = [new Path2D(), new Path2D(), new Path2D()];
    const counts = [0, 0, 0];

    for (let i = 0; i < links.length; i += stride) {
      const l = links[i];
      if (cat >= 0 && l[2] !== cat) continue;
      const pa = pos[l[0]];
      const pb = pos[l[1]];
      if (pa < this.cam.start - margin || pa > this.cam.end + margin) continue;
      if (pb < this.cam.start - margin || pb > this.cam.end + margin) continue;
      const x1 = this.xOf(pa);
      const x2 = this.xOf(pb);
      if ((x1 < -40 && x2 < -40) || (x1 > w + 40 && x2 > w + 40)) continue;
      const g1 = surahs[verses[l[0]].s - 1].place;
      const g2 = surahs[verses[l[1]].s - 1].place;
      const g = g1 === g2 ? (g1 === 'meccan' ? 0 : 1) : 2;
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.min(rx, maxH);
      if (rx < 0.2) continue;
      paths[g].ellipse((x1 + x2) / 2, base, rx, ry, 0, Math.PI, TAU);
      counts[g]++;
    }

    const colors = [pal.meccan, pal.medinan, [0.65, 0.55, 0.98]];
    ctx.globalCompositeOperation = 'lighter';
    for (let g = 0; g < 3; g++) {
      if (!counts[g]) continue;
      ctx.strokeStyle = rgbCss(colors[g]);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.stroke(paths[g]);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    this.glowCam = { ...this.cam };
    this._glowDirty = false;
  }

  _draw2D() {
    this._buildScene();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (state.linksMode !== 'focus') {
      ctx.drawImage(this.scene, 0, 0, this.w, this.h);
    }
    this.canvas.style.transform = 'none';
    this.canvas.style.opacity = '1';
  }

  /* ------------------------------------------------------------- overlay */

  _drawOverlay() {
    const ctx = this.octx;
    const pal = this.palette();
    const y = this.base;
    const now = performance.now();
    ctx.clearRect(0, 0, this.w, this.h);

    const focus = this.selected ?? this.hovered;
    const ppv = this.plotW / this.span;

    // Alternating surah bands, only once there is room for them to read as
    // structure rather than stripes.
    if (ppv > 0.18) {
      ctx.save();
      for (let i = 0; i < state.quran.surahs.length; i++) {
        const s = state.quran.surahs[i];
        const x1 = this.xOf(state.posOfVerse[s.start]);
        const x2 = this.xOf(state.posOfVerse[s.start + s.verses - 1] + 1);
        if (x2 < 0 || x1 > this.w) continue;
        if (i % 2 === 0) {
          ctx.globalAlpha = 0.014;
          ctx.fillStyle = pal.inkCss;
          ctx.fillRect(x1, 0, Math.max(1, x2 - x1), y);
        }
      }
      ctx.restore();
    }

    // The surah you are reading gets a quiet band, so the arcs have a home.
    const contextSurah = focus != null ? state.quran.verses[focus].s : state.activeSurah;
    if (contextSurah) {
      const s = state.quran.surahs[contextSurah - 1];
      if (s) {
        const x1 = this.xOf(state.posOfVerse[s.start]);
        const x2 = this.xOf(state.posOfVerse[s.start + s.verses - 1] + 1);
        ctx.save();
        ctx.fillStyle = pal.accentCss;
        ctx.globalAlpha = 0.045;
        ctx.fillRect(x1, 0, Math.max(1, x2 - x1), y);
        ctx.globalAlpha = 0.18;
        ctx.fillRect(x1, y, Math.max(1, x2 - x1), 2);
        ctx.restore();
      }
    }

    if (this.surahPreview) {
      const p = clamp((now - this._surahPreviewAt) / 180, 0, 1);
      const x1 = this.xOf(this.surahPreview.start);
      const x2 = this.xOf(this.surahPreview.start + this.surahPreview.verses);
      ctx.save();
      ctx.fillStyle = pal.accentCss;
      ctx.globalAlpha = 0.09 * p;
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), this.base);
      ctx.globalAlpha = 0.28 * p;
      ctx.fillRect(x1, this.base, Math.max(1, x2 - x1), 3);
      ctx.restore();
      if (p < 1) this.schedule();
    }

    if (focus != null) {
      const x = this.xOf(posOf(focus));
      const g = ctx.createLinearGradient(0, y, 0, 0);
      g.addColorStop(0, pal.accentCss);
      g.addColorStop(1, 'transparent');
      ctx.save();
      ctx.strokeStyle = g;
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, 12);
      ctx.stroke();
      ctx.restore();
    }

    if (this.focusAlpha < 1) {
      this.focusAlpha = Math.min(1, (now - this._focusFadeAt) / 170);
      if (this.focusAlpha < 1) this.schedule();
    }

    if (focus != null) {
      const accent = this.selected != null ? pal.selCss : pal.inkCss;
      this._drawFocusArcs(ctx, focus, accent, this.focusAlpha);
    }

    ctx.save();
    ctx.strokeStyle = pal.line;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const s of state.quran.surahs) {
      const p = state.posOfVerse[s.start];
      if (p < this.cam.start - 1 || p > this.cam.end + 1) continue;
      const x = this.xOf(p);
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 7);
    }
    ctx.stroke();

    const grad = ctx.createLinearGradient(this.pad, 0, this.w - this.pad, 0);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.06, pal.line);
    grad.addColorStop(0.94, pal.line);
    grad.addColorStop(1, 'transparent');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(this.pad, y + 0.5);
    ctx.lineTo(this.w - this.pad, y + 0.5);
    ctx.stroke();
    ctx.restore();

    // Surah names, once each one has room for a readable label.
    this.labelRects = [];
    if (ppv > 0.35) {
      ctx.save();
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = pal.mutedHex;
      ctx.textAlign = 'left';
      ctx.globalAlpha = 0.8;
      for (const s of state.quran.surahs) {
        const x1 = this.xOf(state.posOfVerse[s.start]);
        const x2 = this.xOf(state.posOfVerse[s.start + s.verses - 1] + 1);
        const wpx = x2 - x1;
        if (wpx < 52 || x2 < 0 || x1 > this.w) continue;
        ctx.fillText(s.name, x1 + 3, y - 10, wpx - 6);
        const textW = Math.min(wpx - 6, ctx.measureText(s.name).width);
        this.labelRects.push({
          n: s.n,
          x1: x1,
          x2: x1 + textW + 6,
          y1: y - 24,
          y2: y - 3,
        });
      }
      ctx.restore();
    }

    if (focus != null) {
      const p = posOf(focus);
      if (p >= this.cam.start - 1 && p <= this.cam.end + 1) {
        const x = this.xOf(p);
        ctx.beginPath();
        ctx.arc(x, y, this.selected != null ? 3.6 : 2.6, 0, TAU);
        ctx.fillStyle = this.selected != null ? pal.selCss : pal.inkCss;
        ctx.globalAlpha = 0.95;
        ctx.fill();
        if (this.selected != null) {
          ctx.beginPath();
          ctx.arc(x, y, 8, 0, TAU);
          ctx.strokeStyle = pal.accentCss;
          ctx.globalAlpha = 0.35;
          ctx.lineWidth = 1;
          ctx.stroke();

          const age = (now - this._pulseAt) / 700;
          if (age >= 0 && age < 1) {
            ctx.beginPath();
            ctx.arc(x, y, 8 + age * 30, 0, TAU);
            ctx.strokeStyle = pal.accentCss;
            ctx.globalAlpha = 0.45 * (1 - age);
            ctx.lineWidth = 1.5;
            ctx.stroke();
            this.schedule();
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    const a = verseAtPos(Math.max(0, Math.round(this.cam.start)));
    const b = verseAtPos(Math.min(TOTAL - 1, Math.round(this.cam.end) - 1));
    ctx.save();
    ctx.fillStyle = pal.mutedHex;
    ctx.globalAlpha = 0.85;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${refOf(a)} — ${refOf(b)}`, this.pad, this.h - 18);
    ctx.restore();

    this._updateMinimap();
  }

  _drawFocusArcs(ctx, index, color, fade = 1) {
    const adj = state.adjacency[index];
    if (!adj || !adj.length) return;
    const maxH = Math.max(20, this.base - 22);
    const cat = state.category;
    const x0 = this.xOf(posOf(index));
    const pal = this.palette();

    ctx.save();
    ctx.lineCap = 'round';

    for (const e of adj) {
      if (cat >= 0 && e.cat !== cat) continue;
      const x2 = this.xOf(posOf(e.o));
      const rx = Math.abs(x2 - x0) / 2;
      if (rx < 0.2) continue;
      const ry = Math.min(rx, maxH);

      // Soft halo, then a gradient core from the opened verse to the other
      // end's revelation colour: teal coming in, amber going out.
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.14 * fade;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.ellipse((x0 + x2) / 2, this.base, rx, ry, 0, Math.PI, TAU);
      ctx.stroke();

      const grad = ctx.createLinearGradient(x0, 0, x2, 0);
      grad.addColorStop(0, color);
      grad.addColorStop(1, e.dir === 1 ? pal.medinanCss : pal.meccanCss);
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.95 * fade;
      ctx.lineWidth = 1.2 + Math.min(e.w || 1, 9) * 0.08;
      ctx.beginPath();
      ctx.ellipse((x0 + x2) / 2, this.base, rx, ry, 0, Math.PI, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  _updateMinimap() {
    if (!this.minimap) return;
    const show = this.span < TOTAL * 0.92;
    this.minimap.hidden = !show;
    if (!show) return;
    this.miniwin.style.left = `${(this.cam.start / TOTAL) * 100}%`;
    this.miniwin.style.width = `${Math.max(0.9, (this.span / TOTAL) * 100)}%`;
  }

  screenOf(index) {
    const p = posOf(index);
    if (p < this.cam.start || p > this.cam.end) return null;
    return { x: this.xOf(p), y: this.base };
  }
}

/* --------------------------------------------------------------- helpers */

function linkHash(i) {
  return ((i * 2654435761) >>> 0) / 4294967296;
}

function hexToRgb(value) {
  let v = String(value).trim();
  if (v.startsWith('#')) v = v.slice(1);
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  const n = parseInt(v, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbCss(rgb) {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}
