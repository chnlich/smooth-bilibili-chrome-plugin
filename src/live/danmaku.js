const DANMAKU_SELECTOR =
  'danmaku, [class*="danmaku"], [id*="danmaku"], [class*="Danmaku"], [id*="Danmaku"], .chat-history-panel, #chat-history-list, #chat-items';

function elementMatches(element) {
  return element.nodeType === 1 && element.matches(DANMAKU_SELECTOR);
}

function elementsInRoot(root) {
  const elements = [];
  if (elementMatches(root)) {
    elements.push(root);
  }
  elements.push(...root.querySelectorAll(DANMAKU_SELECTOR));
  return elements;
}

export class DanmakuVisibilityController {
  constructor(documentObject) {
    this.documentObject = documentObject;
    this.hidden = false;
    this.originalStyles = new Map();
    this.observer = undefined;
    const MutationObserverClass =
      documentObject.defaultView?.MutationObserver || globalThis.MutationObserver;
    if (MutationObserverClass !== undefined && documentObject.documentElement !== null) {
      this.observer = new MutationObserverClass((mutations) => {
        if (!this.hidden) {
          return;
        }
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              this.hideElements(elementsInRoot(node));
            }
          }
        }
      });
      this.observer.observe(documentObject.documentElement, { childList: true, subtree: true });
    }
  }

  findElements() {
    return elementsInRoot(this.documentObject);
  }

  hideElements(elements) {
    for (const element of new Set(elements)) {
      if (!this.originalStyles.has(element)) {
        this.originalStyles.set(element, element.style.display);
      }
      element.style.display = 'none';
    }
  }

  hide() {
    this.hideElements(this.findElements());
    this.hidden = true;
  }

  restore() {
    for (const [element, display] of this.originalStyles.entries()) {
      element.style.display = display;
    }
    this.originalStyles.clear();
    this.hidden = false;
  }

  setHidden(hidden) {
    if (hidden) {
      this.hide();
    } else {
      this.restore();
    }
  }

  destroy() {
    this.observer?.disconnect();
    this.restore();
  }
}
