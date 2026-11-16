// P7: what Settings › Notifications says about how Android delivered this phone's pushes this week
// (PushStats.java, like WhatsApp's google.delivered_priority / google.priority_reduced handling).

/** { text, late, advice } for the stats, or null when there is nothing to tell (no pushes yet, not the phone app). */
export function pushDeliverySummary(stats) {
  const received = Number(stats?.received) || 0;
  if (!received) return null;
  const demoted = Math.min(received, Number(stats?.demoted) || 0);
  const pushes = (count) => `${count} notification${count === 1 ? '' : 's'}`;
  if (!demoted) return { text: `On time: Android delivered all ${pushes(received)} this week at full priority.`, late: false, advice: '' };
  const when = Number(stats?.lastDemotedAt) > 0 ? ` (last ${new Date(Number(stats.lastDemotedAt)).toLocaleString()})` : '';
  return {
    text: `Android delayed ${demoted} of ${pushes(received)} this week by lowering their priority${when}.`,
    late: true,
    advice: 'Messages and calls can then arrive late. In Android Settings › Apps › Hidden Messenger › Battery, choose "Unrestricted", and open the app now and then: Android lowers priority for apps it thinks are rarely used.',
  };
}
