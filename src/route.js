export function routeIdentity(locationObject) {
  const pathname = locationObject.pathname || '/';
  const part = new URLSearchParams(locationObject.search || '').get('p') || undefined;
  if (locationObject.hostname === 'www.bilibili.com' && pathname.startsWith('/video/')) {
    return { routeKind: 'video', bvid: pathname.split('/')[2] || undefined, part };
  }
  if (locationObject.hostname === 'www.bilibili.com' && pathname.startsWith('/list/watchlater')) {
    return { routeKind: 'video', watchLaterItem: pathname.split('/')[3] || undefined, part };
  }
  return { routeKind: 'other', part };
}
