import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCockpitHands } from '../../resources/js/game/cockpitHands.js';

const axis = new THREE.Vector3(0, 0, 1);
let desktopTriangles = 0;
for (const lowPower of [false, true]) {
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false });
    const driver = createCockpitHands({ lowPower, material });
    const wheel = new THREE.Group();
    const frame = new THREE.Group();
    const scene = new THREE.Group();
    wheel.add(driver.hands);
    frame.add(driver.forearms);
    scene.add(wheel, frame);
    const geometries = new Set();
    let meshes = 0;
    let triangles = 0;
    scene.traverse(object => {
        if (!object.isMesh) return;
        meshes++;
        assert.equal(object.material, material, 'hands reuse the shared cockpit shader');
        assert.equal(object.castShadow, false);
        assert.equal(object.frustumCulled, false, 'camera-space appendages stay visible near screen edges');
        assert.ok(object.renderOrder >= 102 && object.renderOrder <= 106);
        const geometry = object.geometry;
        geometries.add(geometry);
        triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
        assert.ok(geometry.attributes.color, 'soft glove shading is baked into vertex colors');
        for (const attribute of Object.values(geometry.attributes)) {
            assert.ok(attribute.array.every(Number.isFinite), 'all geometry attributes are finite');
        }
    });
    assert.ok(meshes >= 3 && meshes <= 6, 'both gloves and articulated sleeves fit a small fixed draw budget');
    assert.ok(triangles < 8000);
    if (!lowPower) desktopTriangles = triangles;
    else assert.ok(triangles < desktopTriangles * 0.75, 'mobile uses materially less geometry');

    for (const angle of [0, -1.8, -0.8, 0.8, 1.8, NaN, Infinity]) {
        const safeAngle = Number.isFinite(angle) ? angle : 0;
        wheel.rotation.z = safeAngle;
        driver.update(angle);
        scene.updateMatrixWorld(true);
        for (const side of ['left', 'right']) {
            const wrist = driver.hands.getObjectByName(`driver-${side}-wrist`);
            const sleeve = driver.forearms.getObjectByName(`driver-${side}-forearm`);
            assert.ok(wrist && sleeve, 'each glove connects to an articulated forearm');
            const contact = wrist.getWorldPosition(new THREE.Vector3());
            const end = sleeve.localToWorld(new THREE.Vector3(0, 1, 0));
            assert.ok(contact.distanceTo(end) < 1e-6, `no floating wrist at steering ${safeAngle}`);
            const elbow = sleeve.localToWorld(new THREE.Vector3(0, 0, 0));
            assert.ok(elbow.y < -0.3 && Math.abs(elbow.x) >= 0.25, 'sleeves originate below the wheel');
            assert.ok(contact.toArray().every(Number.isFinite));
            const localContact = contact.clone().applyAxisAngle(axis, -safeAngle);
            assert.ok(Math.abs(localContact.x) > 0.21 && localContact.y < -0.07, 'wrists remain beside the lower grips');
        }
    }

    let materialDisposals = 0;
    material.addEventListener('dispose', () => materialDisposals++);
    const disposalCounts = new Map([...geometries].map(geometry => [geometry, 0]));
    for (const geometry of geometries) {
        geometry.addEventListener('dispose', () => disposalCounts.set(geometry, disposalCounts.get(geometry) + 1));
    }
    driver.dispose();
    driver.dispose();
    driver.update(0.8);
    assert.equal(materialDisposals, 0, 'shared material remains owned by cockpit');
    assert.ok([...disposalCounts.values()].every(count => count === 1), 'owned geometries are released once');
    assert.equal(driver.hands.parent, null);
    assert.equal(driver.forearms.parent, null);
    material.dispose();
}
console.log('Cockpit hands: grip contact through steering, bounded mobile geometry and resource ownership pass.');
