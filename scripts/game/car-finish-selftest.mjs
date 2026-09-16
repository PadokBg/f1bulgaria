import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyLiveryPatch, deriveCarMasks, makePaintMaterial } from '../../resources/js/game/carModel.js';
import { buildCar } from '../../resources/js/game/car.js';
import { createCarEffects } from '../../resources/js/game/carEffects.js';

// Canvas boundary only: exercise the real atlas classification with the
// red paint, lettering, dark blue carbon and grey carbon in the shipped car.
const colours = [[255, 65, 35], [245, 243, 240], [2, 22, 43], [73, 73, 75]];
const originalDocument = globalThis.document;
let masks;
const atlas = new THREE.Texture({});
try {
    globalThis.document = {
        createElement() {
            return {
                getContext() {
                    return {
                        drawImage() {},
                        getImageData(_x, _y, width, height) {
                            const data = new Uint8ClampedArray(width * height * 4);
                            for (let i = 0; i < width * height; i++) {
                                data.set([...colours[i % colours.length], 255], i * 4);
                            }
                            return { data };
                        },
                    };
                },
            };
        },
    };
    masks = deriveCarMasks(atlas);
} finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
}

const mask = masks.maskA.image.data;
for (const carbon of [2, 3]) {
    assert.ok(mask[carbon * 4] < mask[0] / 2, 'Carbon must not reflect with the painted body clearcoat.');
    assert.ok(mask[carbon * 4 + 1] > mask[1], 'Carbon is rougher than paint.');
    assert.ok(mask[carbon * 4 + 2] < 32, 'Opponent liveries must preserve dark carbon.');
}
assert.ok(mask[4] > mask[12], 'White lettering retains its lacquer.');

const template = { bodyMaterial: new THREE.MeshStandardMaterial({ map: atlas }), masks };
for (const lowPower of [false, true]) {
    const material = makePaintMaterial(template, { lowPower });
    applyLiveryPatch(material, template, 0xaaaaaa);
    const rig = buildCar();
    rig.paintMaterials = [material];
    const effects = createCarEffects(rig, { lowPower });
    const shader = {
        vertexShader: THREE.ShaderLib.physical.vertexShader,
        fragmentShader: THREE.ShaderLib.physical.fragmentShader,
        uniforms: {},
    };
    material.onBeforeCompile(shader, null);
    if (lowPower) {
        assert.equal(material.roughnessMap, null);
        assert.equal(material.clearcoatMap, null);
        assert.equal(material.clearcoatRoughnessMap, null);
        const classification = shader.fragmentShader.indexOf('float carPaintGloss');
        const recolour = shader.fragmentShader.indexOf('vec3 tinted');
        assert.ok(classification >= 0 && classification < recolour, 'Classify the original atlas before opponent recolouring.');
        assert.ok(shader.fragmentShader.includes('material.clearcoat *= '), 'Mobile carbon must have its own finish without extra maps.');
        const finish = shader.fragmentShader.indexOf('roughnessFactor = mix(0.72');
        const dust = shader.fragmentShader.indexOf('roughnessFactor = mix(roughnessFactor, 0.85');
        assert.ok(finish >= 0 && dust > finish, 'The real dust layer must roughen carbon after its finish is applied.');
    }
    // Resolve the actual installed Three.js shader chunks, catching broken
    // hooks on both material paths. GPU compilation is checked in the browser.
    const resolve = (source) => source.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_match, name) => {
        assert.ok(THREE.ShaderChunk[name] !== undefined, `Unknown shader chunk: ${name}`);
        return resolve(THREE.ShaderChunk[name]);
    });
    resolve(shader.vertexShader);
    resolve(shader.fragmentShader);
    effects.dispose();
    rig.dispose();
    material.dispose();
}
masks.maskA.dispose();
masks.maskB.dispose();
atlas.dispose();
template.bodyMaterial.dispose();
console.log('СЕЛФТЕСТ ОК: карбон/боя, ливреи и мобилен финиш без допълнителни карти.');
