// Installs a small browser on globalThis: window, document, location,
// navigator, matchMedia, screen, ResizeObserver and requestAnimationFrame.
// Only what BLIT386 touches is here; the rest is deliberately missing.

import { Element, Node, Text } from './element.js';
import { createImageBitmap, HTMLCanvasElement, Image, ImageBitmap, ImageData, OffscreenCanvas } from './canvas.js';
import { FocusEvent, InputEvent, KeyboardEvent, MouseEvent, PointerEvent, UIEvent, WheelEvent } from './events.js';
import { ORIGIN } from './assets.js';

class Document extends Node {
  readyState = 'complete';
  visibilityState = 'visible';
  hidden = false;
  title = '';
  #byId = new Map();

  constructor(baseURI) {
    super();
    this.baseURI = baseURI;
    this.ownerDocument = this;
    this.documentElement = this.#adopt(new Element('html'));
    this.head = this.#adopt(new Element('head'));
    this.body = this.#adopt(new Element('body'));
    this.documentElement.append(this.head, this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
  }

  #adopt(el) {
    el.ownerDocument = this;
    return el;
  }

  createElement(tag) {
    const t = String(tag).toLowerCase();
    const el = t === 'canvas' ? new HTMLCanvasElement() : t === 'img' ? new Image() : new Element(t);
    return this.#adopt(el);
  }

  createElementNS(_ns, tag) {
    return this.createElement(tag);
  }

  createTextNode(text) {
    const n = new Text(text);
    n.ownerDocument = this;
    return n;
  }

  /** Elements are registered by id when the shell creates them. */
  register(id, el) {
    el.id = id;
    this.#byId.set(id, el);
    return el;
  }

  getElementById(id) {
    return this.#byId.get(id) ?? null;
  }

  querySelector(sel) {
    return sel.startsWith('#') ? this.getElementById(sel.slice(1)) : null;
  }

  querySelectorAll() {
    return [];
  }

  hasFocus() {
    return true;
  }

  get defaultView() {
    return globalThis;
  }
}

class MediaQueryList extends EventTarget {
  constructor(media, matches) {
    super();
    this.media = media;
    this.matches = matches;
    this.onchange = null;
  }

  addListener(fn) {
    this.addEventListener('change', fn);
  }

  removeListener(fn) {
    this.removeEventListener('change', fn);
  }
}

class ScreenOrientation extends EventTarget {
  type = 'landscape-primary';
  angle = 0;

  lock() {
    return Promise.reject(new Error('Orientation lock is not supported in a terminal'));
  }

  unlock() {}
}

class ResizeObserver {
  observe() {}

  unobserve() {}

  disconnect() {}
}

/**
 * Frame scheduler standing in for requestAnimationFrame. The shell drives it:
 * each tick runs every queued callback with the same timestamp, then calls
 * the frame hook so the terminal can grab the finished frame.
 */
class FrameClock {
  #queue = new Map();
  #nextId = 1;

  request(cb) {
    const id = this.#nextId++;
    this.#queue.set(id, cb);
    return id;
  }

  cancel(id) {
    this.#queue.delete(id);
  }

  run(now) {
    const batch = this.#queue;
    this.#queue = new Map();
    for (const cb of batch.values()) {
      try {
        cb(now);
      } catch (err) {
        console.error('[blit-term] Frame callback threw:', err);
      }
    }
    return batch.size;
  }
}

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
}

/**
 * @param {object} opts
 * @param {string} opts.search      query string the game sees in location.search ("?seed=42")
 * @param {object|null} opts.gpu    navigator.gpu replacement, or null for no WebGPU
 * @param {() => {cols:number, rows:number}} opts.viewport  terminal size, for innerWidth/innerHeight
 */
export function installDom({ search = '', gpu = null, viewport }) {
  const href = `${ORIGIN}/${search}`;
  const doc = new Document(`${ORIGIN}/`);
  const clock = new FrameClock();

  // window === globalThis, like in a browser. Bun's global is not an
  // EventTarget, so window events go through a dedicated target.
  const windowEvents = new EventTarget();
  define('window', globalThis);
  define('self', globalThis);
  define('addEventListener', windowEvents.addEventListener.bind(windowEvents));
  define('removeEventListener', windowEvents.removeEventListener.bind(windowEvents));
  define('dispatchEvent', windowEvents.dispatchEvent.bind(windowEvents));
  define('document', doc);
  define('location', {
    href,
    origin: ORIGIN,
    protocol: 'http:',
    host: 'blit.local',
    hostname: 'blit.local',
    port: '',
    pathname: '/',
    search,
    hash: '',
    reload() {},
    assign() {},
    replace() {},
    toString: () => href,
  });
  define('history', { pushState() {}, replaceState() {}, state: null });

  const nav = {
    userAgent: `blit-term (Bun ${Bun.version})`,
    language: 'en-US',
    languages: ['en-US'],
    platform: process.platform,
    maxTouchPoints: 0,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 4,
    onLine: true,
    getGamepads: () => [],
    vibrate: () => false,
  };
  if (gpu) nav.gpu = gpu;
  define('navigator', nav);

  define('screen', {
    get width() {
      return viewport().cols;
    },
    get height() {
      return viewport().rows * 2;
    },
    orientation: new ScreenOrientation(),
  });
  Object.defineProperty(globalThis, 'innerWidth', { get: () => viewport().cols, configurable: true });
  Object.defineProperty(globalThis, 'innerHeight', { get: () => viewport().rows * 2, configurable: true });
  define('devicePixelRatio', 1);
  define('matchMedia', (q) => new MediaQueryList(q, false));
  define('getComputedStyle', (el) => el.style);
  define('ResizeObserver', ResizeObserver);
  define('requestAnimationFrame', (cb) => clock.request(cb));
  define('cancelAnimationFrame', (id) => clock.cancel(id));

  for (const [name, value] of Object.entries({
    Node,
    Element,
    HTMLElement: Element,
    HTMLCanvasElement,
    HTMLImageElement: Image,
    Image,
    ImageBitmap,
    ImageData,
    OffscreenCanvas,
    createImageBitmap,
    UIEvent,
    KeyboardEvent,
    MouseEvent,
    PointerEvent,
    WheelEvent,
    FocusEvent,
    InputEvent,
  })) {
    define(name, value);
  }

  // The canvas the engine boots into, plus the container its error panel uses.
  const container = doc.register('canvas-container', doc.createElement('div'));
  const canvas = doc.register('blit386-canvas', doc.createElement('canvas'));
  container.appendChild(canvas);
  doc.body.appendChild(container);

  return { document: doc, canvas, clock, windowEvents };
}
