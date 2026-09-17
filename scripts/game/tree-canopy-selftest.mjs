import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { createCanopyTexture, createTreeGeometry, patchCanopyNormals } from '../../resources/js/game/treeCanopy.js';
import { buildVegetation } from '../../resources/js/game/vegetation.js';
import { circuitFor } from '../../resources/js/game/circuits.js';
import { prepareTrack } from '../../resources/js/game/track.js';

const texture = createCanopyTexture(4);
const repeat = createCanopyTexture(4);
assert.deepEqual(texture.image.data, repeat.image.data, 'foliage generation must be deterministic');
assert.ok(texture.image.width <= 256 && texture.image.height <= 128);
assert.equal(texture.generateMipmaps, true);
assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
const { data, width, height } = texture.image;
for (let cell = 0; cell < 2; cell++) {
    let covered = 0;
    let total = 0;
    for (let y = 16; y < height; y++) {
        for (let x = cell * width / 2; x < (cell + 1) * width / 2; x++) {
            covered += data[(y * width + x) * 4 + 3] >= 102 ? 1 : 0;
            total++;
        }
    }
    assert.ok(covered / total > 0.2 && covered / total < 0.75, 'canopy must contain both leaf mass and open gaps');
}

for (const kind of ['deciduous', 'conifer', 'shrub']) {
    for (const lowPower of [true, false]) {
        const geometry = createTreeGeometry(kind, 0x48743a, lowPower);
        const again = createTreeGeometry(kind, 0x48743a, lowPower);
        const { position, normal, uv, color, aCanopy } = geometry.attributes;
        assert.deepEqual(position.array, again.attributes.position.array);
        assert.equal(geometry.groups.length, 0, 'trunk and leaves must stay in one draw call');
        assert.ok(position.count / 3 <= (lowPower ? 120 : 200), 'bounded triangles per tree');
        for (const attribute of [position, normal, uv, color, aCanopy]) {
            assert.equal(attribute.count, position.count);
            assert.ok(attribute.array.every(Number.isFinite));
        }
        assert.ok(aCanopy.array.some(value => value === 1));
        assert.ok(geometry.boundingSphere.radius < 8);
        for (let i = 0; i < position.count; i++) {
            assert.ok(Math.abs(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) - 1) < 0.001);
            // The opaque atlas patch must never cut holes through a trunk/branch.
            if (aCanopy.getX(i) === 0) {
                const x = Math.floor(uv.getX(i) * width);
                const y = Math.floor(uv.getY(i) * height);
                assert.equal(data[(y * width + x) * 4 + 3], 255);
            }
        }
        geometry.dispose();
        again.dispose();
    }
}

for (const [type, Material] of [['standard', THREE.MeshStandardMaterial], ['lambert', THREE.MeshLambertMaterial]]) {
    const material = new Material();
    patchCanopyNormals(material);
    const shader = { ...THREE.ShaderLib[type], uniforms: {} };
    material.onBeforeCompile(shader, {});
    assert.ok(shader.vertexShader.includes('aCanopy'));
    assert.ok(shader.fragmentShader.includes('vCanopy'));
    assert.ok(shader.fragmentShader.includes('#include <normal_fragment_begin>'));
    material.dispose();
}
texture.dispose();
repeat.dispose();

const dataTrack = JSON.parse(readFileSync('public/game-tracks/monza.json', 'utf8'));
const circuit = circuitFor(dataTrack.slug);
const track = prepareTrack(dataTrack, circuit);
for (const lowPower of [true, false]) {
    const vegetation = buildVegetation(track, circuit, { heightAt: () => 0 }, { lowPower, birds: false });
    const near = vegetation.group.children.filter(mesh => mesh.name.startsWith('forest-') && mesh.name !== 'forest-billboards');
    assert.ok(near.length > 0);
    const maps = new Set(near.map(mesh => mesh.material.map));
    assert.equal(maps.size, 1, 'every near chunk shares one atlas');
    for (const mesh of near) {
        assert.ok(mesh.isInstancedMesh && !Array.isArray(mesh.material));
        assert.equal(mesh.material.transparent, false, 'no blended sorting or duplicate transparent passes');
        if (!lowPower) {
            assert.equal(mesh.customDepthMaterial.map, mesh.material.map);
            assert.equal(mesh.customDepthMaterial.alphaTest, mesh.material.alphaTest);
        }
    }
    let disposed = 0;
    [...maps][0].addEventListener('dispose', () => disposed++);
    vegetation.dispose();
    vegetation.dispose();
    assert.equal(disposed, 1, 'shared atlas is released exactly once');
    assert.equal(vegetation.group.children.length, 0);
}
console.log('Tree canopy: deterministic cutouts, solid branches, geometry budgets and desktop/mobile shader hooks — OK.');
