import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCockpit } from '../../resources/js/game/cockpit.js';
import { SHIFT_RPM } from '../../resources/js/game/drivetrain.js';

// Creation/disposal must work outside a browser as well as on low-power WebGL.
for (const lowPower of [false, true]) {
    const cockpit = createCockpit({ lowPower });
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    let meshes = 0;
    let triangles = 0;
    cockpit.group.traverse(object => {
        if (!object.isMesh) return;
        meshes++;
        assert.equal(object.castShadow, false);
        assert.equal(object.material.depthWrite, false);
        assert.equal(object.material.depthTest, false);
        assert.equal(object.material.transparent, true, 'cockpit draws after transparent world effects');
        assert.ok(object.renderOrder >= 98, 'cockpit stays above smoke and ghost cars');
        geometries.add(object.geometry);
        materials.add(object.material);
        if (object.material.map) textures.add(object.material.map);
        triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
        for (const attribute of Object.values(object.geometry.attributes)) {
            assert.ok(attribute.array.every(Number.isFinite));
        }
    });
    assert.ok(meshes <= 10, 'cockpit has a fixed small draw-call budget');
    assert.ok(triangles < 6000, 'cockpit must remain inexpensive on mobile');
    assert.ok(textures.size <= 2, 'only a static panel and telemetry texture');

    const halo = cockpit.group.getObjectByName('cockpit-fallback-halo');
    cockpit.update({ hasModel: true, aspect: 16 / 9, fov: 55 }, 0);
    assert.equal(halo.visible, false, 'never draw a second halo over the real model');
    cockpit.update({ hasModel: false, aspect: 16 / 9, fov: 55 }, 0);
    assert.equal(halo.visible, true);
    cockpit.steeringWheel.rotation.z = 0.7;
    cockpit.update({ steer: -1, aspect: 2.16, fov: 42 }, 1 / 60);
    assert.equal(cockpit.steeringWheel.rotation.z, 0.7, 'camera owns steering rotation');
    cockpit.steeringWheel.rotation.z = 0;

    for (const [aspect, fov] of [[16 / 9, 55], [2.16, 42], [4 / 3, 65], [0.56, 92]]) {
        const camera = new THREE.PerspectiveCamera(fov, aspect, 0.045, 2000);
        camera.add(cockpit.group);
        cockpit.update({ aspect, fov, hasModel: true }, 0);
        camera.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(cockpit.steeringWheel);
        const top = new THREE.Vector3(0, bounds.max.y, bounds.max.z).project(camera);
        const left = new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z).project(camera);
        const right = new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z).project(camera);
        assert.ok(top.y < -0.12, `wheel leaves the road clear at aspect ${aspect}`);
        assert.ok(left.y > -1, `the full wheel fits below the road at aspect ${aspect}`);
        assert.ok(left.x > -0.95 && right.x < 0.95, 'grips fit narrow screens');
    }

    const resources = [...geometries, ...materials, ...textures];
    const counts = new Map(resources.map(resource => [resource, 0]));
    for (const resource of resources) {
        resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1));
    }
    cockpit.dispose();
    cockpit.dispose();
    assert.ok([...counts.values()].every(count => count === 1), 'every owned GPU resource disposed exactly once');
    assert.equal(cockpit.group.parent, null);
}

// A fake canvas records paints; this tests update scheduling, not typography.
const labels = [];
const ledPaints = [];
const context = new Proxy({
    fillText: text => labels.push(String(text)),
    fill() { ledPaints.push(this.fillStyle); },
}, {
    get: (target, key) => key in target ? target[key] : () => {},
});
globalThis.document = { createElement: () => ({ getContext: () => context }) };
const cockpit = createCockpit();
const display = cockpit.group.getObjectByName('cockpit-telemetry');
const frame = { speedKph: 127, gear: 3, rpm: 10500, aspect: 16 / 9, fov: 55, hasModel: true };
cockpit.update(frame, 0);
assert.ok(labels.includes('127') && labels.includes('3'));
const version = display.material.map.version;
cockpit.update({ ...frame, speedKph: 128 }, 0.04);
assert.equal(display.material.map.version, version, 'no upload before the 10 Hz interval');
cockpit.update({ ...frame, speedKph: 129 }, 0.06);
assert.equal(display.material.map.version, version + 1);
assert.ok(labels.includes('129'), 'paint the newest telemetry, not a stale queued value');
cockpit.update({ ...frame, speedKph: 129 }, 1);
assert.equal(display.material.map.version, version + 1, 'unchanged values do not upload');
cockpit.update({ ...frame, gear: 0 }, 0.1);
assert.ok(labels.includes('R'), 'gear zero is reverse in the drivetrain');
ledPaints.length = 0;
cockpit.update({ ...frame, rpm: SHIFT_RPM }, 0.1);
assert.equal(ledPaints.filter(color => color === '#76b9ff').length, 5, 'shift lights reach the final band at the current drivetrain shift RPM');
cockpit.dispose();
delete globalThis.document;

console.log('Cockpit: bounded geometry, responsive framing, halo ownership, display throttle and disposal pass.');
