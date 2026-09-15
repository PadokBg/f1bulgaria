import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
    ACESFilmicToneMapping,
    HalfFloatType,
    NoColorSpace,
    PerspectiveCamera,
    Scene,
    SRGBColorSpace,
    UnsignedByteType,
    WebGLRenderTarget,
} from 'three';

// These checks exercise the real passes and render targets at the renderer
// boundary. GPU shader compilation and image quality still need a browser.
const moduleUrl = new URL('../../resources/js/game/lightweightAa.js', import.meta.url);
assert.ok(existsSync(moduleUrl), 'The no-MSAA rendering path needs an AA fallback');
const { createLightweightAa } = await import(moduleUrl);

function rendererFixture() {
    let target = new WebGLRenderTarget(16, 16);
    let cubeFace = 2;
    let mipmapLevel = 1;
    const draws = [];
    return {
        autoClear: false,
        toneMapping: ACESFilmicToneMapping,
        toneMappingExposure: 1.25,
        outputColorSpace: SRGBColorSpace,
        draws,
        getRenderTarget: () => target,
        getActiveCubeFace: () => cubeFace,
        getActiveMipmapLevel: () => mipmapLevel,
        setRenderTarget(next, face = 0, level = 0) {
            target = next;
            cubeFace = face;
            mipmapLevel = level;
        },
        render(object, camera) {
            draws.push({
                object, camera, target,
                autoClear: this.autoClear,
                resolution: object.material?.uniforms?.resolution?.value.clone(),
                source: object.material?.uniforms?.tDiffuse?.value,
                exposure: object.material?.uniforms?.toneMappingExposure?.value,
                defines: { ...object.material?.defines },
            });
        },
    };
}

let checks = 0;
function check(name, test) {
    test();
    checks++;
    console.log(`OK ${name}`);
}

check('Scene retains HDR until output conversion, then FXAA samples display colors', () => {
    const renderer = rendererFixture();
    const aa = createLightweightAa(renderer);
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    aa.setSize(800, 450, 1);
    aa.render(scene, camera);
    const [world, output, fxaa] = renderer.draws;
    assert.equal(renderer.draws.length, 3);
    assert.equal(world.object, scene);
    assert.equal(world.camera, camera);
    assert.equal(world.target.texture.type, HalfFloatType);
    assert.equal(world.target.texture.colorSpace, NoColorSpace);
    assert.equal(world.target.depthBuffer, true);
    assert.equal(world.target.depthTexture, null);
    assert.equal(world.target.samples, 0);
    assert.equal(output.source, world.target.texture);
    assert.equal(output.target.texture.type, UnsignedByteType);
    assert.equal(output.target.depthBuffer, false);
    assert.equal(output.target.stencilBuffer, false);
    assert.equal(output.target.samples, 0);
    assert.equal(output.target.texture.colorSpace, NoColorSpace);
    assert.ok(Object.hasOwn(output.defines, 'ACES_FILMIC_TONE_MAPPING'));
    assert.ok(Object.hasOwn(output.defines, 'SRGB_TRANSFER'));
    assert.equal(output.exposure, 1.25);
    assert.equal(fxaa.source, output.target.texture);
    assert.equal(fxaa.target, null);
    assert.equal(fxaa.object.material.name, 'FXAAShader');
    assert.equal(fxaa.object.material.toneMapped, false);
    aa.dispose();
});

check('AA texels follow physical drawing-buffer size on DPR and scale changes', () => {
    const renderer = rendererFixture();
    const aa = createLightweightAa(renderer);
    for (const [width, height, ratio, expectedWidth, expectedHeight] of [
        [800, 450, 1.5, 1200, 675],
        [801, 451, 0.9, 720, 405],
        [0, 0, 1, 1, 1],
    ]) {
        renderer.draws.length = 0;
        aa.setSize(width, height, ratio);
        aa.render(new Scene(), new PerspectiveCamera());
        const [world, output, fxaa] = renderer.draws;
        assert.equal(world.target.width, expectedWidth);
        assert.equal(world.target.height, expectedHeight);
        assert.equal(output.target.width, expectedWidth);
        assert.equal(output.target.height, expectedHeight);
        assert.equal(fxaa.resolution.x, 1 / expectedWidth);
        assert.equal(fxaa.resolution.y, 1 / expectedHeight);
    }
    aa.dispose();
});

check('Rendering restores the caller target and autoClear on success or failure', () => {
    for (const fail of [false, true]) {
        const renderer = rendererFixture();
        const originalTarget = renderer.getRenderTarget();
        const originalRender = renderer.render;
        renderer.render = function (...args) {
            originalRender.apply(this, args);
            if (fail && this.draws.length === 2) throw new Error('GPU failure');
        };
        const aa = createLightweightAa(renderer);
        const render = () => aa.render(new Scene(), new PerspectiveCamera());
        if (fail) assert.throws(render, /GPU failure/);
        else render();
        assert.ok(renderer.draws.every((draw) => draw.autoClear));
        assert.equal(renderer.getRenderTarget(), originalTarget);
        assert.equal(renderer.getActiveCubeFace(), 2);
        assert.equal(renderer.getActiveMipmapLevel(), 1);
        assert.equal(renderer.autoClear, false);
        assert.equal(renderer.toneMapping, ACESFilmicToneMapping);
        assert.equal(renderer.toneMappingExposure, 1.25);
        assert.equal(renderer.outputColorSpace, SRGBColorSpace);
        aa.dispose();
        originalTarget.dispose();
    }
});

check('Disposal releases targets and materials once and prevents later drawing', () => {
    const renderer = rendererFixture();
    const aa = createLightweightAa(renderer);
    aa.render(new Scene(), new PerspectiveCamera());
    const [world, output, fxaa] = renderer.draws;
    const resources = [world.target, output.target, output.object.material, fxaa.object.material];
    const disposed = new Map(resources.map((resource) => [resource, 0]));
    for (const resource of resources) {
        resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1));
    }
    aa.dispose();
    aa.dispose();
    aa.setSize(1920, 1080, 2);
    aa.render(new Scene(), new PerspectiveCamera());
    assert.equal(renderer.draws.length, 3);
    assert.ok([...disposed.values()].every((count) => count === 1));
});

console.log(`${checks} lightweight AA checks passed (no GPU compilation).`);
