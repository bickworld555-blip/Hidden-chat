// Draws a voice waveform (bars, newest on the right) on a canvas. Called once per animation frame with the
// current levels from a ref, so a recording or a speaking indicator never goes through React state.

/** Bar geometry for `count` slots in a canvas `width` wide: [{ x, height }] for the given levels (0..1). */
export function waveformBars(levels, { width, height, count, gap = 2, minHeight = 3 }) {
  const slot = width / count;
  const barWidth = Math.max(1, Math.min(4, slot - gap));
  const start = count - levels.length;
  return levels.map((level, index) => {
    const barHeight = Math.max(minHeight, Math.min(height, level * height));
    return { x: (start + index) * slot + (slot - barWidth), y: (height - barHeight) / 2, width: barWidth, height: barHeight };
  });
}

/** Paints the bars; the colour comes from the canvas's CSS `color` (so light and dark themes both work). */
export function drawWaveform(canvas, levels, count) {
  if (!canvas) return;
  const ratio = globalThis.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.fillStyle = getComputedStyle(canvas).color || '#5d6662';
  for (const bar of waveformBars(levels, { width, height, count, gap: 2 * ratio, minHeight: 3 * ratio })) {
    const radius = Math.min(bar.width / 2, 2 * ratio);
    context.beginPath();
    if (context.roundRect) context.roundRect(bar.x, bar.y, bar.width, bar.height, radius);
    else context.rect(bar.x, bar.y, bar.width, bar.height);
    context.fill();
  }
}
