import assert from 'node:assert/strict';

import * as THREE from 'three';

import { createAsphaltTextures } from '../../resources/js/game/asphaltTexture.js';

const desktop = createAsphaltTextures({ detail: true, anisotropy: 8, repeat: 2 });
const mobile = createAsphaltTextures({ detail: false, anisotropy: 4, repeat: 2 });
const repeat = createAsphaltTextures({ detail: false });

assert.ok(desktop.map?.isDataTexture, 'the asphalt surface needs a ready diffuse texture');
// A phone must not allocate/upload the two PBR maps it never samples.
assert.equal(mobile.normalMap, null);
assert.equal(mobile.roughnessMap, null);
assert.deepEqual(mobile.map.image.data, desktop.map.image.data);
assert.deepEqual(repeat.map.image.data, mobile.map.image.data);

for (const texture of Object.values(desktop)) {
    assert.ok(texture.isDataTexture);
    assert.ok(texture.image.width <= 256 && texture.image.height <= 256);
    assert.equal(texture.wrapS, THREE.RepeatWrapping);
    assert.equal(texture.wrapT, THREE.RepeatWrapping);
    assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
    assert.equal(texture.magFilter, THREE.LinearFilter);
    assert.equal(texture.generateMipmaps, true);
    assert.equal(texture.anisotropy, 8);
    assert.equal(texture.repeat.x, 2);
    assert.equal(texture.repeat.y, 2);
}
assert.equal(desktop.map.colorSpace, THREE.SRGBColorSpace);
assert.equal(desktop.normalMap.colorSpace, THREE.NoColorSpace);
assert.equal(desktop.roughnessMap.colorSpace, THREE.NoColorSpace);

// A border in the baked tile must be no more visible than an ordinary row.
// Flat color also fails: a minimum variance preserves actual aggregate detail.
const { data, width, height } = desktop.map.image;
let sum = 0;
let sumSquares = 0;
let innerDifference = 0;
let seamDifference = 0;
for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
        const value = data[(y * width + x) * 4];
        sum += value;
        sumSquares += value * value;
        if (x > 0) innerDifference += Math.abs(value - data[(y * width + x - 1) * 4]);
    }
    seamDifference += Math.abs(data[y * width * 4] - data[(y * width + width - 1) * 4]);
}
const mean = sum / (width * height);
const variance = sumSquares / (width * height) - mean * mean;
assert.ok(mean > 60 && mean < 120, `asphalt should retain a dark neutral base (${mean})`);
assert.ok(variance > 8 && variance < 180, `aggregate should remain fine and low contrast (${variance})`);
assert.ok(seamDifference / height < innerDifference / (height * (width - 1)) * 1.3);

for (const textures of [desktop, mobile, repeat]) {
    for (const texture of Object.values(textures)) texture?.dispose();
}

console.log('Асфалт: детерминиран фин тайл, плавно повторение, mipmaps и мобилен бюджет — OK.');
