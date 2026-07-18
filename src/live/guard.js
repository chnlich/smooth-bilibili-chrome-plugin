export function installLivePlaybackGuard(video, { playbackRate = 1, logger, isEnabled = () => true }) {
  let approvedTime = video.currentTime;
  let internalRateChange = false;
  let restoringTime = false;
  let approvedForwardSeek = false;

  const synchronizeCurrentTime = () => {
    approvedTime = video.currentTime;
    approvedForwardSeek = false;
  };

  const enforcePlaybackRate = () => {
    if (!isEnabled() || video.playbackRate === playbackRate) {
      return;
    }
    logger.warn(`拒绝直播非 ${playbackRate}× 播放速度: ${video.playbackRate}`);
    internalRateChange = true;
    try {
      video.playbackRate = playbackRate;
    } finally {
      internalRateChange = false;
    }
  };

  const rejectForwardSeek = () => {
    if (!isEnabled()) {
      synchronizeCurrentTime();
      return;
    }
    if (video.currentTime <= approvedTime || approvedForwardSeek) {
      approvedTime = video.currentTime;
      approvedForwardSeek = false;
      return;
    }
    logger.warn(`拒绝直播非用户前跳: ${approvedTime} -> ${video.currentTime}`);
    restoringTime = true;
    try {
      video.currentTime = approvedTime;
    } finally {
      restoringTime = false;
    }
  };

  const onRateChange = () => {
    if (isEnabled() && !internalRateChange) {
      enforcePlaybackRate();
    }
  };
  const onSeeking = () => {
    if (!restoringTime) {
      rejectForwardSeek();
    }
  };
  const onTimeUpdate = () => {
    if (!isEnabled()) {
      synchronizeCurrentTime();
      return;
    }
    if (!restoringTime && video.currentTime >= approvedTime) {
      approvedTime = video.currentTime;
    }
  };

  video.addEventListener('ratechange', onRateChange);
  video.addEventListener('seeking', onSeeking);
  video.addEventListener('timeupdate', onTimeUpdate);
  enforcePlaybackRate();
  return {
    get approvedTime() {
      return approvedTime;
    },
    approveForwardSeek() {
      approvedForwardSeek = true;
    },
    enforce() {
      enforcePlaybackRate();
    },
    synchronize() {
      synchronizeCurrentTime();
    },
    destroy() {
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('timeupdate', onTimeUpdate);
    },
  };
}
