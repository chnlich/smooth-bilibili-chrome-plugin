export async function readStoredEvents(context, extensionId, startAfterEventId = 0) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
    return await page.evaluate((initialAfterEventId) => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ version: 1, type: 'logs:max-event-id' }, (snapshot) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (snapshot?.ok !== true || !Number.isInteger(snapshot.maxEventId) || snapshot.maxEventId < 0) {
          reject(new Error(snapshot?.error?.message || 'extension log snapshot was rejected'));
          return;
        }
        const events = [];
        let afterEventId = initialAfterEventId;
        const readPage = () => chrome.runtime.sendMessage({
          version: 1,
          type: 'logs:events-page',
          limit: 250,
          afterEventId,
          maxEventId: snapshot.maxEventId,
        }, (response) => {
          if (chrome.runtime.lastError !== undefined) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response?.ok !== true || !Array.isArray(response.events) || typeof response.hasMore !== 'boolean') {
            reject(new Error(response?.error?.message || 'extension log event page was rejected'));
            return;
          }
          events.push(...response.events);
          if (!response.hasMore) {
            resolve({ maxEventId: snapshot.maxEventId, events });
            return;
          }
          if (!Number.isInteger(response.nextAfterEventId) || response.nextAfterEventId <= afterEventId) {
            reject(new Error('extension log paging did not advance'));
            return;
          }
          afterEventId = response.nextAfterEventId;
          readPage();
        });
        readPage();
      });
    }), startAfterEventId);
  } finally {
    await page.close();
  }
}

export async function readMaxEventId(context, extensionId) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(() => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ version: 1, type: 'logs:max-event-id' }, (snapshot) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (snapshot?.ok !== true || !Number.isInteger(snapshot.maxEventId) || snapshot.maxEventId < 0) {
          reject(new Error(snapshot?.error?.message || 'extension log snapshot was rejected'));
          return;
        }
        resolve(snapshot.maxEventId);
      });
    }));
  } finally {
    await page.close();
  }
}
