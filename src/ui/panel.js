import { fail } from '../errors.js';

const PANEL_STYLE = `
:host { all: initial; }
.panel {
  position: fixed;
  z-index: 2147483647;
  right: 16px;
  bottom: 16px;
  width: 270px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, .18);
  border-radius: 10px;
  background: rgba(18, 24, 36, .96);
  color: #f4f7fb;
  box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.title { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 8px; font-weight: 700; }
.state { color: #8bd5ff; }
.rows { display: grid; gap: 4px; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.label { color: #aeb9c7; }
.value { text-align: right; overflow-wrap: anywhere; }
.message { margin-top: 8px; color: #ffd38b; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
button {
  border: 1px solid #5a6c83;
  border-radius: 5px;
  padding: 4px 7px;
  background: #243247;
  color: #fff;
  cursor: pointer;
  font: inherit;
}
button:hover { background: #30435e; }
button[hidden] { display: none; }
`;

function text(documentObject, value) {
  return documentObject.createTextNode(value);
}

export class StatusPanel {
  constructor(documentObject, mode, actions = {}) {
    this.documentObject = documentObject;
    this.actions = actions;
    this.host = documentObject.createElement('div');
    this.host.dataset.bilibiliBufferPanel = 'true';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = documentObject.createElement('style');
    style.textContent = PANEL_STYLE;
    this.shadow.append(style);
    this.panel = documentObject.createElement('section');
    this.panel.className = 'panel';
    this.shadow.append(this.panel);
    this.rows = new Map();
    this.message = documentObject.createElement('div');
    this.message.className = 'message';
    this.actionsElement = documentObject.createElement('div');
    this.actionsElement.className = 'actions';
    this.createContents(mode);
    documentObject.documentElement.append(this.host);
  }

  createContents(mode) {
    const title = this.documentObject.createElement('div');
    title.className = 'title';
    title.append(text(this.documentObject, 'Bilibili 抗卡'));
    this.stateElement = this.documentObject.createElement('span');
    this.stateElement.className = 'state';
    title.append(this.stateElement);
    this.panel.append(title);
    for (const [key, label] of [
      ['mode', '模式'],
      ['inventory', '连续库存'],
      ['delay', '估算延迟'],
      ['quality', '画质'],
      ['speed', '速度'],
      ['multiplier', '下载倍率'],
    ]) {
      const row = this.documentObject.createElement('div');
      row.className = 'row';
      row.dataset.field = key;
      const labelElement = this.documentObject.createElement('span');
      labelElement.className = 'label';
      labelElement.append(text(this.documentObject, label));
      const valueElement = this.documentObject.createElement('span');
      valueElement.className = 'value';
      row.append(labelElement, valueElement);
      this.rows.set(key, valueElement);
      this.panel.append(row);
    }
    this.rows.get('mode').textContent = mode;
    this.panel.append(this.message, this.actionsElement);
  }

  setAction(name, label, callback, visible = true) {
    let button = this.actionsElement.querySelector(`[data-action="${name}"]`);
    if (button === null) {
      button = this.documentObject.createElement('button');
      button.dataset.action = name;
      button.addEventListener('click', () => callback());
      this.actionsElement.append(button);
    }
    button.textContent = label;
    button.hidden = !visible;
    this.host.dataset[`action${name.replace(/(^|-)([a-z])/g, (_match, _prefix, character) => character.toUpperCase())}`] =
      visible ? 'visible' : 'hidden';
  }

  setModel(model) {
    this.stateElement.textContent = model.state || '';
    for (const [key, value] of Object.entries(model)) {
      const element = this.rows.get(key);
      if (element !== undefined) {
        element.textContent = value === undefined ? '未提供' : String(value);
      }
    }
    this.message.textContent = model.message || '';
  }

  setMessage(message) {
    this.message.textContent = message;
  }

  destroy() {
    this.host.remove();
  }
}

export function createStatusPanel(documentObject, mode, actions) {
  if (documentObject.querySelector('[data-bilibili-buffer-panel="true"]') !== null) {
    fail('UI_DUPLICATE_PANEL', '页面已经存在抗卡面板');
  }
  return new StatusPanel(documentObject, mode, actions);
}
