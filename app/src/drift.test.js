import test from 'node:test';
import assert from 'node:assert/strict';
import {DRIFT_DEFAULTS, validateDrift, carMixerCompatible} from './drift.js';

const car = {fc_mixer: [1,0,0,0, 0,0,0,-1], fc_mixer_servos: [false,true], fc_arm_enabled:true, fc_arm_channel:5, fc_wifi_conditions:{coexist:[7,1700,2100]}};
test('old profiles default to disabled and clone the range', () => {
  const a = validateDrift(); a.range[0] = 900;
  assert.equal(validateDrift().enabled, false);
  assert.equal(validateDrift().range[0], 1700);
});
test('valid car mixer, negative steering, and settings round trip', () => {
  assert.equal(carMixerCompatible(car.fc_mixer, car.fc_mixer_servos), true);
  const s = {...DRIFT_DEFAULTS, enabled:true};
  assert.deepEqual(validateDrift(JSON.parse(JSON.stringify(s)),car), s);
});
test('reject aircraft mixer, negative throttle, missing steering and nonfinite values', () => {
  for (const mix of [[1,1,1,1],[-1,0,0,0,0,0,0,1],[1,0,0,0],[NaN,0,0,0,0,0,0,1]]) {
    assert.equal(carMixerCompatible(mix, [false,true]), false);
  }
  assert.throws(() => validateDrift({...DRIFT_DEFAULTS,enabled:true},{...car,fc_mixer:[1,1,1,1]}),/mixer/);
});
test('range, bounds, integer fields and types are validated', () => {
  for (const patch of [{enabled:'true'},{channel:4},{channel:17},{channel:8.1},{range:[2100,1700]},{range:[899,2100]},
    {range:[1700,2100,2100]},{threshold_dps:NaN},{ramp_dps:Infinity},{max_reduction_percent:31},{attack_ms:49},{recovery_ms:1001},{attack_ms:120.5}]) {
    assert.throws(() => validateDrift({...DRIFT_DEFAULTS,...patch}), /parameters/);
  }
});
test('arm and Wi-Fi channels cannot be used for assistance', () => {
  for (const channel of [5,7]) assert.throws(() => validateDrift({...DRIFT_DEFAULTS,enabled:true,channel},car), /channel_conflict/);
  assert.equal(validateDrift({...DRIFT_DEFAULTS,enabled:false,channel:5},car).enabled,false);
});
