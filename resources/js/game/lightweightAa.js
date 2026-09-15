import { HalfFloatType, UnsignedByteType, WebGLRenderTarget } from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

/**
 * Edge smoothing when the full effects chain and context MSAA are unavailable.
 * The caller owns activation, so devices with native AA allocate no extra targets.
 * Width/height are CSS pixels; pixelRatio includes the current render scale.
 */
export function createLightweightAa(renderer) {
    const sceneTarget = new WebGLRenderTarget(1, 1, {
        type: HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
        samples: 0,
    });
    const colorTarget = new WebGLRenderTarget(1, 1, {
        type: UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
        samples: 0,
    });
    const output = new OutputPass();
    const fxaa = new ShaderPass(FXAAShader);
    fxaa.renderToScreen = true;
    fxaa.material.toneMapped = false;
    let disposed = false;

    return {
        setSize(width, height, pixelRatio = 1) {
            if (disposed) return;
            const physicalWidth = Math.max(1, Math.floor(width * pixelRatio));
            const physicalHeight = Math.max(1, Math.floor(height * pixelRatio));
            sceneTarget.setSize(physicalWidth, physicalHeight);
            colorTarget.setSize(physicalWidth, physicalHeight);
            fxaa.uniforms.resolution.value.set(1 / physicalWidth, 1 / physicalHeight);
        },

        render(scene, camera) {
            if (disposed) return;
            const previousTarget = renderer.getRenderTarget();
            const previousCubeFace = renderer.getActiveCubeFace();
            const previousMipmapLevel = renderer.getActiveMipmapLevel();
            const previousAutoClear = renderer.autoClear;

            try {
                renderer.autoClear = true;
                renderer.setRenderTarget(sceneTarget);
                renderer.render(scene, camera);

                // Offscreen scene rendering stays linear HDR. OutputPass applies
                // tone mapping and sRGB once, before FXAA's luminance edge search.
                // The byte target stays NoColorSpace to avoid decoding it again.
                output.render(renderer, colorTarget, sceneTarget);
                fxaa.render(renderer, null, colorTarget);
            } finally {
                renderer.autoClear = previousAutoClear;
                renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
            }
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            sceneTarget.dispose();
            colorTarget.dispose();
            output.dispose();
            fxaa.dispose();
        },
    };
}
