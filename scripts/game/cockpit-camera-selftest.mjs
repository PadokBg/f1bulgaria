import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createChaseCamera } from '../../resources/js/game/camera.js';
import { createSimFromData } from '../../resources/js/game/sim.js';
import { createTvDirector } from '../../resources/js/game/tvDirector.js';
import { circuitFor } from '../../resources/js/game/circuits.js';

const data = JSON.parse(readFileSync('public/game-tracks/monza.json', 'utf8'));
const sim = createSimFromData(data);
const root = new THREE.Group();
const body = new THREE.Group();
root.add(body);
const helmet = new THREE.Group();
helmet.position.set(0, 0.608, 0.069);
body.add(helmet);
const rig = { root, body, helmet };
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 2200);
const overlay = new THREE.Group();
const controller = createChaseCamera(camera, sim.track, { rig, halo: overlay });
root.position.set(sim.state.x, sim.surface.height, sim.state.z);
root.rotation.y = sim.state.heading;
body.rotation.set(0.025, 0, -0.015);
const originalState = JSON.stringify(sim.state);

controller.setMode('onboard');
assert.equal(helmet.visible, false, 'own helmet must not surround the eye');
assert.ok(camera.near <= 0.05, 'close cockpit parts must survive near clipping');
controller.snap(sim.state, sim.surface);
const eye = body.localToWorld(new THREE.Vector3(0, 0.62, 0.10));
assert.ok(camera.position.distanceTo(eye) < 0.001, 'snap places the driver under the model halo, not above it');
controller.update(1 / 60, sim.state, sim, { ax: 0, ay: 0 });
assert.ok(camera.position.distanceTo(eye) < 0.005);
assert.equal(JSON.stringify(sim.state), originalState, 'presentation cannot alter physics');

// Recoveries and collisions must never move the eye outside the cockpit.
controller.kick(1, 1, 0);
for (let i = 0; i < 30; i++) {
    controller.update(1 / 60, sim.state, sim, { ax: -40, ay: 30 });
    assert.ok(camera.position.distanceTo(eye) < 0.09, 'collision feedback remains inside the seat');
    assert.ok(camera.position.toArray().every(Number.isFinite));
}
controller.setMode('chase');
assert.equal(camera.near, 0.5);
assert.equal(helmet.visible, true);
assert.equal(overlay.visible, false);

// A model can finish loading after the player has chosen the cockpit.
rig.helmet = null;
controller.setMode('onboard');
rig.helmet = new THREE.Group();
rig.helmet.position.copy(helmet.position);
body.add(rig.helmet);
controller.update(1 / 60, sim.state, sim);
assert.equal(rig.helmet.visible, false);

const director = createTvDirector(camera, sim.track, circuitFor(data.slug), { chaseCamera: controller, halo: overlay });
const frames = new Float32Array([
    sim.state.x, sim.state.z, sim.state.heading,
    sim.state.x + 0.1, sim.state.z, sim.state.heading,
]);
assert.equal(director.start(frames), true);
assert.equal(rig.helmet.visible, true, 'TV replay restores the driver helmet');
assert.equal(camera.near, 0.5);
director.setCamera('onboard');
assert.equal(rig.helmet.visible, false);
assert.ok(camera.near <= 0.05);
director.setCamera('tv');
assert.equal(rig.helmet.visible, true);
assert.equal(camera.near, 0.5);
director.dispose();

controller.setMode('onboard');
controller.dispose();
assert.equal(rig.helmet.visible, true);
assert.equal(camera.near, 0.5);
console.log('Cockpit camera: measured eye anchor, clipping, helmet lifecycle, bounded impacts and physics isolation — OK.');
