// Minimal DOM element: enough for the engine to style, append and listen.
// Nothing is laid out; the terminal is the only "screen".

class StyleDeclaration {
  setProperty(name, value) {
    this[name] = value;
  }

  removeProperty(name) {
    delete this[name];
  }

  getPropertyValue(name) {
    return this[name] ?? '';
  }
}

class ClassList {
  #set = new Set();

  add(...names) {
    for (const n of names) this.#set.add(n);
  }

  remove(...names) {
    for (const n of names) this.#set.delete(n);
  }

  toggle(name, force) {
    const on = force ?? !this.#set.has(name);
    if (on) this.#set.add(name);
    else this.#set.delete(name);
    return on;
  }

  contains(name) {
    return this.#set.has(name);
  }
}

export class Node extends EventTarget {
  childNodes = [];
  parentNode = null;
  ownerDocument = null;

  get parentElement() {
    return this.parentNode;
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof Element);
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
}

export class Text extends Node {
  constructor(data) {
    super();
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }
}

export class Element extends Node {
  style = new StyleDeclaration();
  classList = new ClassList();
  dataset = {};
  #attrs = new Map();
  id = '';
  className = '';
  tabIndex = -1;

  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent ?? '').join('');
  }

  set textContent(value) {
    this.childNodes = [new Text(value ?? '')];
  }

  get innerHTML() {
    return this.textContent;
  }

  set innerHTML(value) {
    this.textContent = String(value).replace(/<[^>]*>/g, '');
  }

  setAttribute(name, value) {
    this.#attrs.set(name, String(value));
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) {
    return this.#attrs.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.#attrs.has(name);
  }

  removeAttribute(name) {
    this.#attrs.delete(name);
  }

  focus() {}

  blur() {}

  setPointerCapture() {}

  releasePointerCapture() {}

  hasPointerCapture() {
    return false;
  }

  requestPointerLock() {}

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  get clientWidth() {
    return this.getBoundingClientRect().width;
  }

  get clientHeight() {
    return this.getBoundingClientRect().height;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}
