export function createCoreEventSubscription(core) {
  if (typeof core.addEventListener === 'function' && typeof core.removeEventListener === 'function') {
    return (name, callback) => {
      core.addEventListener(name, callback);
      return () => core.removeEventListener(name, callback);
    };
  }
  if (typeof core.on === 'function' && typeof core.off === 'function') {
    return (name, callback) => {
      core.on(name, callback);
      return () => core.off(name, callback);
    };
  }
  if (typeof core.on === 'function' && typeof core.removeListener === 'function') {
    return (name, callback) => {
      core.on(name, callback);
      return () => core.removeListener(name, callback);
    };
  }
  if (typeof core.addListener === 'function' && typeof core.removeListener === 'function') {
    return (name, callback) => {
      core.addListener(name, callback);
      return () => core.removeListener(name, callback);
    };
  }
  if (typeof core.addListener === 'function' && typeof core.off === 'function') {
    return (name, callback) => {
      core.addListener(name, callback);
      return () => core.off(name, callback);
    };
  }
  return undefined;
}

export function supportsCoreEvents(core) {
  return createCoreEventSubscription(core) !== undefined;
}
