function clone(value) {
  return structuredClone(value);
}

function compareKeys(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const result = compareKeys(left[index], right[index]);
      if (result !== 0) return result;
    }
    return left.length - right.length;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function inRange(range, key) {
  if (range === null || range === undefined) return true;
  if (range.kind === 'lowerBound') {
    const result = compareKeys(key, range.lower);
    return result > 0 || (result === 0 && range.open === false);
  }
  if (range.kind === 'bound') {
    const lower = compareKeys(key, range.lower);
    const upper = compareKeys(key, range.upper);
    return (lower > 0 || (lower === 0 && range.lowerOpen === false)) &&
      (upper < 0 || (upper === 0 && range.upperOpen === false));
  }
  throw new Error(`未支持的 fake IDB range: ${range.kind}`);
}

export class FakeIDBKeyRange {
  static lowerBound(lower, open = false) {
    return { kind: 'lowerBound', lower, open };
  }

  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return { kind: 'bound', lower, upper, lowerOpen, upperOpen };
  }
}

class FakeRequest {
  constructor(transaction, executor) {
    this.transaction = transaction;
    this.result = undefined;
    this.error = null;
    this.onsuccess = undefined;
    this.onerror = undefined;
    transaction.enqueue(() => {
      try {
        this.result = executor();
        this.onsuccess?.({ target: this });
      } catch (error) {
        this.error = error;
        transaction.error = error;
        transaction.onerror?.({ target: this });
        this.onerror?.({ target: this });
      }
      transaction.finishRequest();
    });
  }
}

class FakeCursorRequest {
  constructor(transaction, records) {
    this.transaction = transaction;
    this.result = undefined;
    this.error = null;
    this.onsuccess = undefined;
    this.onerror = undefined;
    this.records = records;
    this.position = 0;
    this.emit();
  }

  emit() {
    this.transaction.enqueue(() => {
      try {
        const record = this.records[this.position];
        this.result = record === undefined
          ? null
          : new FakeCursor(this, record);
        this.onsuccess?.({ target: this });
      } catch (error) {
        this.error = error;
        this.transaction.error = error;
        this.transaction.onerror?.({ target: this });
        this.onerror?.({ target: this });
      }
      this.transaction.finishRequest();
    });
  }
}

class FakeCursor {
  constructor(request, record) {
    this.request = request;
    this.key = record.key;
    this.primaryKey = record.primaryKey ?? record.key;
    this.value = clone(record.value);
  }

  continue() {
    this.request.position += 1;
    this.request.emit();
  }
}

function cloneState(state) {
  return {
    sessions: new Map([...state.sessions].map(([key, value]) => [key, clone(value)])),
    events: new Map([...state.events].map(([key, value]) => [key, clone(value)])),
    nextEventId: state.nextEventId,
  };
}

class FakeObjectStore {
  constructor(transaction, name) {
    this.transaction = transaction;
    this.name = name;
  }

  get(key) {
    return new FakeRequest(this.transaction, () => {
      const value = this.name === 'sessions'
        ? this.transaction.state.sessions.get(key)
        : this.transaction.state.events.get(key);
      return value === undefined ? undefined : clone(value);
    });
  }

  add(value) {
    return new FakeRequest(this.transaction, () => {
      if (this.name === 'sessions') {
        if (this.transaction.state.sessions.has(value.sessionId)) {
          throw Object.assign(new Error('session already exists'), { name: 'ConstraintError' });
        }
        this.transaction.state.sessions.set(value.sessionId, clone(value));
        return value.sessionId;
      }
      if (this.transaction.database.failNextEventAdd) {
        this.transaction.database.failNextEventAdd = false;
        throw Object.assign(new Error('synthetic event write failure'), { name: 'QuotaExceededError' });
      }
      const eventId = this.transaction.state.nextEventId;
      this.transaction.state.nextEventId += 1;
      const stored = clone(value);
      stored.eventId = eventId;
      this.transaction.state.events.set(eventId, stored);
      return eventId;
    });
  }

  openCursor(range, direction = 'next') {
    const records = this.name === 'sessions'
      ? [...this.transaction.state.sessions.entries()]
        .map(([key, value]) => ({ key, value }))
        .filter((record) => inRange(range, record.key))
      : [...this.transaction.state.events.entries()]
        .map(([key, value]) => ({ key, value }))
        .filter((record) => inRange(range, record.key));
    records.sort((left, right) => compareKeys(left.key, right.key));
    if (direction === 'prev') records.reverse();
    return new FakeCursorRequest(this.transaction, records);
  }

  index(name) {
    if (name !== 'sessionSequence') throw new Error(`未知 fake IDB index: ${name}`);
    return new FakeIndex(this.transaction);
  }

  createIndex() {
    return this;
  }
}

class FakeIndex {
  constructor(transaction) {
    this.transaction = transaction;
  }

  get(key) {
    return new FakeRequest(this.transaction, () => {
      const event = [...this.transaction.state.events.values()]
        .find((candidate) => compareKeys([candidate.sessionId, candidate.sequence], key) === 0);
      return event === undefined ? undefined : clone(event);
    });
  }

  openCursor(range, direction = 'next') {
    const records = [...this.transaction.state.events.values()]
      .map((value) => ({
        key: [value.sessionId, value.sequence],
        primaryKey: value.eventId,
        value,
      }))
      .filter((record) => inRange(range, record.key));
    records.sort((left, right) => compareKeys(left.key, right.key));
    if (direction === 'prev') records.reverse();
    return new FakeCursorRequest(this.transaction, records);
  }
}

class FakeTransaction {
  constructor(database, storeNames, mode) {
    this.database = database;
    this.storeNames = Array.isArray(storeNames) ? storeNames : [storeNames];
    this.mode = mode;
    this.state = undefined;
    this.error = null;
    this.oncomplete = undefined;
    this.onabort = undefined;
    this.onerror = undefined;
    this.aborted = false;
    this.completed = false;
    this.started = false;
    this.running = false;
    this.pending = 0;
    this.queue = [];
    this.completionPending = false;
    database.scheduleTransaction(this);
  }

  start() {
    this.started = true;
    this.state = cloneState(this.database.state);
    this.pump();
  }

  objectStore(name) {
    if (!this.storeNames.includes(name)) throw new Error(`store ${name} 不在事务中`);
    return new FakeObjectStore(this, name);
  }

  enqueue(callback) {
    if (this.aborted || this.completed) throw new Error('fake IDB transaction is not active');
    this.pending += 1;
    this.queue.push(callback);
    this.pump();
  }

  pump() {
    if (!this.started || this.running || this.aborted || this.completed || this.queue.length === 0) return;
    this.running = true;
    queueMicrotask(() => {
      this.running = false;
      if (this.aborted || this.completed) return;
      const callback = this.queue.shift();
      callback();
      this.pump();
      this.maybeComplete();
    });
  }

  finishRequest() {
    this.pending -= 1;
    this.pump();
    this.maybeComplete();
  }

  maybeComplete() {
    if (
      this.aborted ||
      this.completed ||
      this.pending !== 0 ||
      this.queue.length !== 0 ||
      this.running ||
      this.completionPending
    ) {
      return;
    }
    this.completionPending = true;
    queueMicrotask(() => {
      if (this.aborted || this.completed || this.pending !== 0 || this.queue.length !== 0 || this.running) {
        this.completionPending = false;
        return;
      }
      const complete = () => {
        if (this.aborted || this.completed) return;
        this.completionPending = false;
        this.completed = true;
        if (this.mode === 'readwrite') this.database.state = this.state;
        this.database.releaseTransaction(this);
        this.oncomplete?.({ target: this });
      };
      const commitBarrier = this.mode === 'readwrite' ? this.database.takeCommitBarrier() : undefined;
      if (commitBarrier === undefined) {
        complete();
      } else {
        void commitBarrier.then(complete);
      }
    });
  }

  abort() {
    if (this.aborted || this.completed) return;
    this.aborted = true;
    this.queue = [];
    queueMicrotask(() => {
      if (this.completed) return;
      this.completed = true;
      this.database.releaseTransaction(this);
      this.onabort?.({ target: this });
    });
  }
}

class FakeDatabase {
  constructor() {
    this.initialized = false;
    this.failNextEventAdd = false;
    this.stores = new Set();
    this.state = { sessions: new Map(), events: new Map(), nextEventId: 1 };
    this.activeWrite = false;
    this.pendingWrites = [];
    this.nextCommitBarrier = undefined;
  }

  get objectStoreNames() {
    const database = this;
    return { contains(name) { return database.stores.has(name); } };
  }

  createObjectStore(name) {
    if (name === 'sessions' || name === 'events') {
      this.stores.add(name);
      return new FakeObjectStore(null, name);
    }
    throw new Error(`未知 fake IDB store: ${name}`);
  }

  transaction(storeNames, mode) {
    return new FakeTransaction(this, storeNames, mode);
  }

  close() {}

  holdNextCommit() {
    if (this.nextCommitBarrier !== undefined) throw new Error('fake IDB 已有待释放的提交栅栏');
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    this.nextCommitBarrier = barrier;
    return release;
  }

  takeCommitBarrier() {
    const barrier = this.nextCommitBarrier;
    this.nextCommitBarrier = undefined;
    return barrier;
  }

  scheduleTransaction(transaction) {
    if (transaction.mode === 'readwrite') {
      if (this.activeWrite) this.pendingWrites.push(transaction);
      else {
        this.activeWrite = true;
        transaction.start();
      }
      return;
    }
    transaction.start();
  }

  releaseTransaction(transaction) {
    if (transaction.mode !== 'readwrite') return;
    if (this.pendingWrites.length > 0) {
      this.pendingWrites.shift().start();
    } else {
      this.activeWrite = false;
    }
  }
}

export class FakeIndexedDB {
  constructor() {
    this.database = new FakeDatabase();
  }

  open() {
    const request = {
      result: undefined,
      error: null,
      transaction: undefined,
      onupgradeneeded: undefined,
      onsuccess: undefined,
      onerror: undefined,
    };
    queueMicrotask(() => {
      request.result = this.database;
      if (!this.database.initialized) {
        this.database.initialized = true;
        request.transaction = {
          objectStore: (name) => new FakeObjectStore(null, name),
        };
        request.onupgradeneeded?.({ target: request });
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }
}
