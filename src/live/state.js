import { LIVE_STATE } from '../constants.js';
import { fail } from '../errors.js';

const TRANSITIONS = Object.freeze({
  [LIVE_STATE.LIVE]: new Set([
    LIVE_STATE.STALL,
    LIVE_STATE.DELAYED,
    LIVE_STATE.USER_PAUSED,
    LIVE_STATE.GAP_UNRECOVERABLE,
  ]),
  [LIVE_STATE.STALL]: new Set([LIVE_STATE.RECOVERING, LIVE_STATE.USER_PAUSED, LIVE_STATE.GAP_UNRECOVERABLE]),
  [LIVE_STATE.RECOVERING]: new Set([
    LIVE_STATE.LIVE,
    LIVE_STATE.DELAYED,
    LIVE_STATE.USER_PAUSED,
    LIVE_STATE.GAP_UNRECOVERABLE,
  ]),
  [LIVE_STATE.DELAYED]: new Set([
    LIVE_STATE.LIVE,
    LIVE_STATE.STALL,
    LIVE_STATE.RECOVERING,
    LIVE_STATE.USER_PAUSED,
    LIVE_STATE.GAP_UNRECOVERABLE,
  ]),
  [LIVE_STATE.USER_PAUSED]: new Set([
    LIVE_STATE.LIVE,
    LIVE_STATE.STALL,
    LIVE_STATE.RECOVERING,
    LIVE_STATE.DELAYED,
    LIVE_STATE.GAP_UNRECOVERABLE,
  ]),
  [LIVE_STATE.GAP_UNRECOVERABLE]: new Set([LIVE_STATE.RECOVERING, LIVE_STATE.LIVE]),
});

export class LiveStateMachine {
  constructor(initialState = LIVE_STATE.LIVE) {
    this.state = initialState;
    this.history = [{ state: initialState, reason: 'initial' }];
  }

  transition(nextState, reason) {
    if (nextState === this.state) {
      return this.state;
    }
    if (!TRANSITIONS[this.state].has(nextState)) {
      fail('STATE_INVALID_TRANSITION', `直播状态不能从 ${this.state} 转为 ${nextState}: ${reason}`);
    }
    this.state = nextState;
    this.history.push({ state: nextState, reason });
    return this.state;
  }

  onStall() {
    if (
      this.state !== LIVE_STATE.USER_PAUSED &&
      this.state !== LIVE_STATE.GAP_UNRECOVERABLE &&
      this.state !== LIVE_STATE.STALL &&
      this.state !== LIVE_STATE.RECOVERING
    ) {
      this.transition(LIVE_STATE.STALL, 'media waiting/stalled');
    }
    return this.state;
  }

  onRecovering() {
    if (
      this.state !== LIVE_STATE.USER_PAUSED &&
      this.state !== LIVE_STATE.GAP_UNRECOVERABLE &&
      this.state !== LIVE_STATE.RECOVERING
    ) {
      this.transition(LIVE_STATE.RECOVERING, 'ordered segment recovery');
    }
    return this.state;
  }

  onRecoveryReady(delaySeconds) {
    if (this.state === LIVE_STATE.USER_PAUSED || this.state === LIVE_STATE.GAP_UNRECOVERABLE) {
      return this.state;
    }
    const nextState = delaySeconds > 3 ? LIVE_STATE.DELAYED : LIVE_STATE.LIVE;
    this.transition(nextState, 'recovery watermark reached');
    return this.state;
  }

  onDelayChanged(delaySeconds) {
    if (
      this.state === LIVE_STATE.USER_PAUSED ||
      this.state === LIVE_STATE.GAP_UNRECOVERABLE ||
      this.state === LIVE_STATE.STALL ||
      this.state === LIVE_STATE.RECOVERING
    ) {
      return this.state;
    }
    this.transition(delaySeconds > 3 ? LIVE_STATE.DELAYED : LIVE_STATE.LIVE, 'live delay changed');
    return this.state;
  }

  onUserPause() {
    if (this.state !== LIVE_STATE.GAP_UNRECOVERABLE) {
      this.transition(LIVE_STATE.USER_PAUSED, 'user pause');
    }
    return this.state;
  }

  onUserPlay(delaySeconds, hasRecoveryWatermark) {
    if (this.state !== LIVE_STATE.USER_PAUSED) {
      return this.state;
    }
    if (!hasRecoveryWatermark) {
      this.transition(LIVE_STATE.RECOVERING, 'user requested play before recovery watermark');
      return this.state;
    }
    return this.onRecoveryReady(delaySeconds);
  }

  onGap(reason) {
    if (this.state !== LIVE_STATE.GAP_UNRECOVERABLE) {
      this.transition(LIVE_STATE.GAP_UNRECOVERABLE, reason);
    }
    return this.state;
  }

  manualSkipGap() {
    if (this.state !== LIVE_STATE.GAP_UNRECOVERABLE) {
      fail('STATE_MANUAL_ACTION_INVALID', '只有不可恢复缺口状态可以跨过缺口');
    }
    this.transition(LIVE_STATE.RECOVERING, 'user clicked skip gap');
    return this.state;
  }

  manualReturnLive() {
    if (
      this.state !== LIVE_STATE.GAP_UNRECOVERABLE &&
      this.state !== LIVE_STATE.DELAYED &&
      this.state !== LIVE_STATE.USER_PAUSED &&
      this.state !== LIVE_STATE.STALL &&
      this.state !== LIVE_STATE.RECOVERING
    ) {
      fail('STATE_MANUAL_ACTION_INVALID', '当前直播状态没有可丢弃的积压内容');
    }
    this.transition(LIVE_STATE.RECOVERING, 'user clicked return live');
    return this.state;
  }
}
