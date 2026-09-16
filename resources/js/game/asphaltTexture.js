import * as THREE from 'three';

const SIZE = 256;
const MASK = SIZE - 1;

/**
 * Фин асфалтов агрегат за 2 m тайл, без повтарящи се едри пукнатини.
 * Всички съседи се четат с wrap, включително нормалите по шева. Телефонът
 * получава само diffuse; desktop заменя съществуващите PBR карти.
 */
export function createAsphaltTextures({ detail = true, anisotropy = 1, repeat = 1 } = {}) {
    const grain = new Float32Array(SIZE * SIZE);
    let seed = 0x61c88743;
    for (let i = 0; i < grain.length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        grain[i] = (seed >>> 0) / 0xffffffff;
    }
    const sample = (x, y) => grain[((y & MASK) * SIZE) + (x & MASK)];
    const diffuse = new Uint8Array(SIZE * SIZE * 4);
    const normals = detail ? new Uint8Array(diffuse.length) : null;
    const roughness = detail ? new Uint8Array(diffuse.length) : null;

    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const i = (y * SIZE + x) * 4;
            const center = sample(x, y);
            const aggregate = (sample(x - 1, y) + sample(x + 1, y) + sample(x, y - 1) + sample(x, y + 1)) * 0.25;
            const value = Math.round(88 + (center - 0.5) * 22 + (aggregate - 0.5) * 12);
            diffuse[i] = value;
            diffuse[i + 1] = value + 1;
            diffuse[i + 2] = value + 3;
            diffuse[i + 3] = 255;

            if (detail) {
                const dx = (sample(x - 1, y) - sample(x + 1, y)) * 0.22;
                const dy = (sample(x, y - 1) - sample(x, y + 1)) * 0.22;
                const length = Math.sqrt(dx * dx + dy * dy + 1);
                normals[i] = Math.round((dx / length * 0.5 + 0.5) * 255);
                normals[i + 1] = Math.round((dy / length * 0.5 + 0.5) * 255);
                normals[i + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
                normals[i + 3] = 255;
                const matte = Math.round(236 + (center - 0.5) * 16);
                roughness[i] = matte;
                roughness[i + 1] = matte;
                roughness[i + 2] = matte;
                roughness[i + 3] = 255;
            }
        }
    }

    const texture = (data, colorSpace) => {
        if (!data) return null;
        const map = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
        map.wrapS = THREE.RepeatWrapping;
        map.wrapT = THREE.RepeatWrapping;
        map.minFilter = THREE.LinearMipmapLinearFilter;
        map.magFilter = THREE.LinearFilter;
        map.generateMipmaps = true;
        map.anisotropy = anisotropy;
        map.repeat.set(repeat, repeat);
        map.colorSpace = colorSpace;
        map.needsUpdate = true;
        return map;
    };

    return {
        map: texture(diffuse, THREE.SRGBColorSpace),
        normalMap: texture(normals, THREE.NoColorSpace),
        roughnessMap: texture(roughness, THREE.NoColorSpace),
    };
}
