import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as THREE from 'three';

import { circuitFor } from '../../resources/js/game/circuits.js';
import { applySurfaceShaders } from '../../resources/js/game/surfaceShader.js';
import { prepareTrack } from '../../resources/js/game/track.js';

const data = JSON.parse(readFileSync('public/game-tracks/monza.json', 'utf8'));
const circuit = circuitFor(data.slug);
const track = prepareTrack(data, circuit);
const mix = (a, b, weight) => a * (1 - weight) + b * weight;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

for (const lowPower of [false, true]) {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    const controller = applySurfaceShaders({ asphalt: material }, track, {
        ...circuit, atmosphere: { ...circuit.atmosphere, night: true },
    }, { lowPower });
    const shader = {
        ...THREE.ShaderLib.physical,
        uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.physical.uniforms),
    };
    material.onBeforeCompile(shader, null);

    // Run the emitted scalar GLSL, without a GPU: the map-free branch is the
    // real phone path. This catches a floor after wet/paint as well as an
    // over-polished dry braking zone, rather than matching shader source text.
    const start = shader.fragmentShader.indexOf('float roughnessFactor = roughness;');
    const end = shader.fragmentShader.indexOf('#include <metalnessmap_fragment>', start);
    const scalar = shader.fragmentShader.slice(start, end)
        .replace(/#ifdef USE_ROUGHNESSMAP[\s\S]*?#endif/g, '')
        .replace(/\bfloat\b/g, 'let');
    const evaluate = new Function('roughness', 'sRub', 'sBrake', 'sPatch', 'sPaint', 'uNightSheen', 'sWetK', 'mix', 'clamp', 'max', `${scalar}\nreturn roughnessFactor;`);
    const roughness = ({ rubber = 1, brake = 1, patch = 1, paint = 0, night = 0, wet = 0 } = {}) => evaluate(0.9, rubber, brake, patch, paint, night, wet, mix, clamp, Math.max);

    const dry = roughness();
    assert.ok(dry >= 0.65, `dry braking zones should stay matte on ${lowPower ? 'mobile' : 'desktop'} (${dry})`);
    assert.ok(dry < roughness({ rubber: 0, brake: 0, patch: 0 }), 'rubber should still subtly polish the racing line');
    assert.ok(roughness({ night: 1 }) < dry, 'night lighting retains its sheen');
    assert.ok(roughness({ wet: 0.5 }) < dry, 'rain progressively lowers roughness');
    assert.ok(Math.abs(roughness({ wet: 1 }) - 0.06) < 0.00001, 'the dry floor must not flatten puddle reflections');
    assert.ok(Math.abs(roughness({ paint: 1 }) - 0.45) < 0.00001, 'paint retains its own material response');

    controller.dispose();
    material.dispose();
}

console.log('Асфалт: матова суха линия, отделна боя и запазен мокър/нощен блясък — OK.');
