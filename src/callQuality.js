// Call network health, read from RTCPeerConnection.getStats() every QUALITY_SAMPLE_MS while a 1:1 call is connected.
//
// Two jobs (src/callEngine.js acts on both):
//  1. Video level: on a lossy or slow uplink (4G under load, a busy cell) the sender steps its own video down (bitrate,
//     resolution, frame rate) before the network drops whole frames, and back up slowly once it has been clean for a
//     while. The browser's congestion control already adapts inside the cap; the cap stops it from probing back up into
//     the same loss burst again and again, which is what a receiver sees as a frozen picture.
//  2. Stall: packets stop arriving while ICE still says "connected" (a mobile network that silently stopped routing the
//     path). ICE consent checks take tens of seconds to notice; the engine restarts ICE after STALL_SAMPLES instead.

import { VIDEO_MAX_BITRATE, VIDEO_MAX_FRAMERATE } from './rtc.js';

export const QUALITY_SAMPLE_MS = 2_000;
// Consecutive samples with no inbound RTP before the path counts as stalled (≈4 s).
export const STALL_SAMPLES = 2;
// Samples in a row that must be bad to step down, or good to step up one level.
export const DOWNGRADE_SAMPLES = 2;
export const UPGRADE_SAMPLES = 5;

// Highest first. `scale` divides the 1280×720 capture (1.5 → 853×480, 2.5 → 512×288).
export const VIDEO_LEVELS = Object.freeze([
  Object.freeze({ name: 'high', maxBitrate: VIDEO_MAX_BITRATE, scale: 1, maxFramerate: VIDEO_MAX_FRAMERATE }),
  Object.freeze({ name: 'medium', maxBitrate: 700_000, scale: 1.5, maxFramerate: 24 }),
  Object.freeze({ name: 'low', maxBitrate: 300_000, scale: 2.5, maxFramerate: 15 }),
]);

// The worst level each signal calls for (index into VIDEO_LEVELS).
const LOSS_LIMITS = [0.05, 0.12]; // fraction of our video the peer reports lost
const RTT_LIMITS = [0.35, 0.7]; // seconds
const BANDWIDTH_LIMITS = [900_000, 400_000]; // the browser's own estimate of what the uplink can carry

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Collapses one getStats() report into the few numbers the engine acts on (unknowns stay null). */
export function readQualitySample(report) {
  const sample = {
    inboundPackets: 0,
    inboundLost: 0,
    sentVideoLoss: null,
    rtt: null,
    availableOutgoingBitrate: null,
    cpuLimited: false,
    pathType: null,
  };
  if (!report || typeof report.forEach !== 'function') return sample;
  let selectedPairId = null;
  const pairs = [];
  report.forEach((stat) => {
    if (stat.type === 'inbound-rtp') {
      sample.inboundPackets += finite(stat.packetsReceived) ?? 0;
      sample.inboundLost += Math.max(0, finite(stat.packetsLost) ?? 0);
    } else if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') {
      const lost = finite(stat.fractionLost);
      if (lost != null) sample.sentVideoLoss = Math.max(sample.sentVideoLoss ?? 0, lost);
    } else if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
      if (stat.qualityLimitationReason === 'cpu') sample.cpuLimited = true;
    } else if (stat.type === 'transport' && stat.selectedCandidatePairId) {
      selectedPairId = stat.selectedCandidatePairId;
    } else if (stat.type === 'candidate-pair') {
      pairs.push(stat);
    }
  });
  const pair = (selectedPairId && pairs.find((item) => item.id === selectedPairId))
    ?? pairs.find((item) => item.nominated && item.state === 'succeeded')
    ?? null;
  if (pair) {
    sample.rtt = finite(pair.currentRoundTripTime);
    sample.availableOutgoingBitrate = finite(pair.availableOutgoingBitrate);
    const local = typeof report.get === 'function' ? report.get(pair.localCandidateId) : null;
    const remote = typeof report.get === 'function' ? report.get(pair.remoteCandidateId) : null;
    if (local?.candidateType || remote?.candidateType) {
      sample.pathType = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
    }
  }
  return sample;
}

/** The video level one sample asks for, ignoring history: 0 (high) … VIDEO_LEVELS.length - 1 (low). */
export function levelFor(sample) {
  const worst = (value, limits, higherIsWorse = true) => {
    if (value == null) return 0;
    let level = 0;
    limits.forEach((limit, index) => { if (higherIsWorse ? value > limit : value < limit) level = index + 1; });
    return level;
  };
  return Math.max(
    worst(sample.sentVideoLoss, LOSS_LIMITS),
    worst(sample.rtt, RTT_LIMITS),
    worst(sample.availableOutgoingBitrate, BANDWIDTH_LIMITS, false),
    sample.cpuLimited ? 1 : 0,
  );
}

export function createQualityTracker() {
  return { level: 0, worse: 0, better: 0, lastPackets: null, lastLost: 0, still: 0, inboundLoss: 0 };
}

/**
 * Folds a sample into the tracker. Returns { level, changed, stalled, quality } where quality is
 * 'good' | 'weak' | 'poor' for the call screen (our uplink level and the loss on what we receive).
 */
export function updateQuality(tracker, sample) {
  // Stall: inbound packets did not move since the previous sample.
  let stalled = false;
  if (tracker.lastPackets != null && sample.inboundPackets <= tracker.lastPackets) {
    tracker.still += 1;
    stalled = tracker.still >= STALL_SAMPLES;
  } else {
    tracker.still = 0;
  }
  const received = tracker.lastPackets == null ? 0 : sample.inboundPackets - tracker.lastPackets;
  const lost = tracker.lastPackets == null ? 0 : sample.inboundLost - tracker.lastLost;
  if (received + lost > 0) tracker.inboundLoss = Math.max(0, lost) / (received + Math.max(0, lost));
  tracker.lastPackets = sample.inboundPackets;
  tracker.lastLost = sample.inboundLost;

  // Video level with hysteresis: quick to step down, slow to step back up.
  const wanted = levelFor(sample);
  const before = tracker.level;
  if (wanted > tracker.level) {
    tracker.better = 0;
    tracker.worse += 1;
    if (tracker.worse >= DOWNGRADE_SAMPLES) { tracker.level = wanted; tracker.worse = 0; }
  } else if (wanted < tracker.level) {
    tracker.worse = 0;
    tracker.better += 1;
    if (tracker.better >= UPGRADE_SAMPLES) { tracker.level -= 1; tracker.better = 0; }
  } else {
    tracker.worse = 0;
    tracker.better = 0;
  }
  const receivePoor = tracker.inboundLoss > 0.2 ? 2 : tracker.inboundLoss > 0.08 ? 1 : 0;
  const worst = stalled ? 2 : Math.max(tracker.level, receivePoor);
  return { level: tracker.level, changed: tracker.level !== before, stalled, quality: ['good', 'weak', 'poor'][worst] };
}

/** True when the ICE servers include a TURN relay we can authenticate to. */
export function hasTurnRelay(iceServers) {
  return Array.isArray(iceServers) && iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return Boolean(server?.username && server?.credential) && urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url));
  });
}
