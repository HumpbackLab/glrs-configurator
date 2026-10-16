export const DRIFT_DEFAULTS = Object.freeze({
  enabled: false, channel: 8, range: [1700, 2100],
  threshold_dps: 20, ramp_dps: 80, max_reduction_percent: 15,
  attack_ms: 120, recovery_ms: 300,
});

export const DRIFT_FIELDS = [
  ['threshold_dps', 5, 100, '°/s'], ['ramp_dps', 20, 300, '°/s'],
  ['max_reduction_percent', 0, 30, '%'], ['attack_ms', 50, 500, 'ms'],
  ['recovery_ms', 100, 1000, 'ms'],
];

export function carMixerCompatible(mixer, servos) {
  if (!Array.isArray(mixer) || !Array.isArray(servos) || !mixer.length || mixer.length > 32 || mixer.length % 4) return false;
  let throttle = false, steering = false;
  for (let i = 0; i < mixer.length; i += 4) {
    const row = mixer.slice(i, i + 4);
    if (!row.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
    if (row.every((v) => v === 0)) continue;
    if (!servos[i / 4] && row[0] > 0 && row.slice(1).every((v) => v === 0)) throttle = true;
    else if (servos[i / 4] && row[0] === 0 && row[1] === 0 && row[2] === 0 && row[3] !== 0) steering = true;
    else return false;
  }
  return throttle && steering;
}

export function validateDrift(value, context) {
  const s = value === undefined ? {...DRIFT_DEFAULTS, range: [...DRIFT_DEFAULTS.range]} : value;
  const number = (v, min, max, integer = false) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v));
  if (!s || typeof s.enabled !== 'boolean' || !number(s.channel, 5, 16, true) ||
      !Array.isArray(s.range) || s.range.length !== 2 || !s.range.every((v) => number(v, 900, 2100, true)) || s.range[0] >= s.range[1] ||
      !DRIFT_FIELDS.every(([key, min, max]) => number(s[key], min, max, key.endsWith('_ms')))) throw new Error('parameters');
  if (s.enabled && context) {
    if (!carMixerCompatible(context.fc_mixer, context.fc_mixer_servos)) throw new Error('mixer');
    if ((context.fc_arm_enabled && context.fc_arm_channel === s.channel) ||
        context.fc_wifi_conditions?.coexist?.[0] === s.channel) throw new Error('channel_conflict');
  }
  return {enabled: s.enabled, channel: s.channel, range: [...s.range],
    ...Object.fromEntries(DRIFT_FIELDS.map(([key]) => [key, s[key]]))};
}
