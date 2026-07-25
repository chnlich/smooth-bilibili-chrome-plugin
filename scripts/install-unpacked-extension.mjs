export async function installUnpackedExtension(browser, extensionDirectory) {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send('Extensions.loadUnpacked', { path: extensionDirectory });
    return result.id;
  } finally {
    await session.detach();
  }
}
