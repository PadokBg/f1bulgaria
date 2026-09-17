import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as THREE from 'three';

import { createAtmosphere } from '../../resources/js/game/atmosphere.js';
import { circuitFor } from '../../resources/js/game/circuits.js';
import { createNightLights } from '../../resources/js/game/nightLights.js';
import { prepareTrack } from '../../resources/js/game/track.js';

const data = JSON.parse(readFileSync('public/game-tracks/bahrain.json', 'utf8'));
const circuit = circuitFor(data.slug);
const track = prepareTrack(data, circuit);

// Artificial floodlight bounce must survive a black sky and a sky resample.
// Daylight continues to follow the sampled sky, preserving the HDRI transition.
for (const slug of ['bahrain', 'monza']) {
    const scene = new THREE.Scene();
    const hemisphere = new THREE.HemisphereLight();
    const renderer = { toneMappingExposure: 0.9 };
    const atmosphere = createAtmosphere({ renderer, scene, circuit: circuitFor(slug), hemisphere, lowPower: true });
    const black = new THREE.DataTexture(new Float32Array(16 * 8 * 4), 16, 8, THREE.RGBAFormat, THREE.FloatType);
    const bright = new THREE.DataTexture(new Float32Array(16 * 8 * 4).fill(0.8), 16, 8, THREE.RGBAFormat, THREE.FloatType);
    atmosphere.sampleSky({ hdr: black });
    const darkSkyFill = hemisphere.color.clone();
    const darkHorizon = atmosphere.horizon.clone();
    atmosphere.sampleSky({ hdr: bright });
    assert.notDeepEqual(atmosphere.horizon, darkHorizon, 'fog must still track sky brightness');
    if (atmosphere.night) {
        assert.deepEqual(hemisphere.color, darkSkyFill, 'night ambient fill must not depend on sky brightness');
    } else {
        assert.notDeepEqual(hemisphere.color, darkSkyFill, 'day ambient fill must continue to follow the sky');
    }
    atmosphere.dispose();
    assert.equal(renderer.toneMappingExposure, 0.9, 'disposing restores exposure');
    assert.equal(scene.children.length, 0, 'atmosphere removes its objects');
    black.dispose();
    bright.dispose();
}

for (const lowPower of [false, true]) {
    const scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight(circuit.atmosphere.sunColor, circuit.atmosphere.sunIntensity);
    sun.position.set(100, 180, -140);
    scene.add(sun);
    const originalColor = sun.color.clone();
    const originalIntensity = sun.intensity;
    const controller = createNightLights(scene, track, circuit, null, { lowPower, sun });
    const count = lowPower ? 2 : 4;
    assert.equal(controller.spotLights.length, count, 'spotlight budget stays fixed');
    assert.notDeepEqual(sun.color, originalColor, 'night key light receives the neutral floodlight tint');
    const lights = controller.spotLights.slice();
    const camera = new THREE.PerspectiveCamera();
    for (let row = 0; row < track.count; row += 13) {
        controller.update(0.1, { x: track.xs[row], z: track.zs[row] }, camera, row);
        assert.equal(scene.children.filter((child) => child.isLight).length, count + 2, 'no lights are added during a lap');
        assert.deepEqual(controller.spotLights, lights, 'the same spotlight objects are reused');
        assert.ok(lights.every((light) => Number.isFinite(light.intensity) && light.intensity >= 0));
    }
    controller.dispose();
    controller.dispose();
    assert.deepEqual(sun.color, originalColor, 'dispose restores the exact original linear key color');
    assert.equal(sun.intensity, originalIntensity, 'dispose restores key intensity');
    assert.deepEqual(scene.children, [sun], 'all temporary lights and effects are removed');
}

console.log('Нощно осветление: независим небесен fill, фиксирани 4/2 прожектора и възстановяване на сцената — OK.');
