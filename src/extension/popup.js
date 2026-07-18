import { EXTENSION_PREFERENCES } from '../constants.js';

const PREFERENCES = Object.freeze(Object.values(EXTENSION_PREFERENCES));

const statusElement = document.querySelector('[data-status]');
const inputs = new Map(
  PREFERENCES.map((name) => [name, document.querySelector(`input[data-preference="${name}"]`)]),
);

async function loadPreferences() {
  const values = await chrome.storage.local.get(PREFERENCES);
  for (const name of PREFERENCES) {
    inputs.get(name).checked = values[name] !== false;
  }
}

for (const name of PREFERENCES) {
  inputs.get(name).addEventListener('change', async (event) => {
    await chrome.storage.local.set({ [name]: event.currentTarget.checked });
    statusElement.textContent = '已保存，下次刷新页面后生效。';
  });
}

void loadPreferences().catch((error) => {
  console.error('[BilibiliBuffer] Popup 读取设置失败', error);
  statusElement.textContent = `读取设置失败: ${error.message || error}`;
});
