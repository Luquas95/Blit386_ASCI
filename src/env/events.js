// Browser event classes the engine listens for. Bun ships Event and EventTarget
// but not the UI event subclasses, so we add the fields BLIT386 actually reads.

export class UIEvent extends Event {
  constructor(type, init = {}) {
    super(type, { bubbles: init.bubbles ?? true, cancelable: init.cancelable ?? true });
    this.detail = init.detail ?? 0;
  }
}

export class KeyboardEvent extends UIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.key = init.key ?? '';
    this.code = init.code ?? '';
    this.location = init.location ?? 0;
    this.repeat = init.repeat ?? false;
    this.isComposing = false;
    this.shiftKey = init.shiftKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.altKey = init.altKey ?? false;
    this.metaKey = init.metaKey ?? false;
  }

  getModifierState(name) {
    if (name === 'Shift') return this.shiftKey;
    if (name === 'Control') return this.ctrlKey;
    if (name === 'Alt') return this.altKey;
    if (name === 'Meta') return this.metaKey;
    return false;
  }
}

export class MouseEvent extends UIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.pageX = this.clientX;
    this.pageY = this.clientY;
    this.offsetX = this.clientX;
    this.offsetY = this.clientY;
    this.screenX = this.clientX;
    this.screenY = this.clientY;
    this.movementX = init.movementX ?? 0;
    this.movementY = init.movementY ?? 0;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.shiftKey = init.shiftKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.altKey = init.altKey ?? false;
    this.metaKey = init.metaKey ?? false;
  }
}

export class PointerEvent extends MouseEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
    this.width = 1;
    this.height = 1;
    this.pressure = this.buttons ? 0.5 : 0;
  }

  getCoalescedEvents() {
    return [this];
  }
}

export class WheelEvent extends MouseEvent {
  static DOM_DELTA_PIXEL = 0;
  static DOM_DELTA_LINE = 1;
  static DOM_DELTA_PAGE = 2;

  constructor(type, init = {}) {
    super(type, init);
    this.deltaX = init.deltaX ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.deltaZ = 0;
    this.deltaMode = init.deltaMode ?? 0;
  }
}

export class FocusEvent extends UIEvent {}

export class InputEvent extends UIEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.data = init.data ?? null;
    this.inputType = init.inputType ?? '';
  }
}
