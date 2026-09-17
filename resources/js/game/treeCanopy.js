import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyPatch } from './materialPatch.js';

const UP = new THREE.Vector3(0, 1, 0);
const LEAF_UV_BOTTOM = 0.125;
const noise = seed => {
    const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
};

/** Two small cutouts shared by the entire near forest; no downloads or canvas. */
export function createCanopyTexture(anisotropy = 1) {
    const width = 256;
    const height = 128;
    const data = new Uint8Array(width * height * 4);
    // White transparent padding prevents dark filtering fringes. A separate
    // opaque strip lets branches share the foliage material and instance batch.
    for (let i = 0; i < data.length; i += 4) {
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = i / 4 < width * 8 ? 255 : 0;
    }
    const ellipse = (cx, cy, rx, ry, angle, shade) => {
        const radius = Math.max(rx, ry) + 1;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        for (let y = Math.max(16, Math.floor(cy - radius)); y <= Math.min(height - 2, cy + radius); y++) {
            for (let x = Math.max(1, Math.floor(cx - radius)); x <= Math.min(width - 2, cx + radius); x++) {
                const dx = x + 0.5 - cx;
                const dy = y + 0.5 - cy;
                const u = (dx * c + dy * s) / rx;
                const v = (-dx * s + dy * c) / ry;
                const distance = Math.sqrt(u * u + v * v);
                if (distance >= 1) continue;
                const offset = (y * width + x) * 4;
                const alpha = Math.min(255, Math.round((1 - distance) * Math.min(rx, ry) * 255));
                if (alpha < data[offset + 3]) continue;
                const brightness = Math.round(shade + (1 - distance) * 16);
                data[offset] = data[offset + 1] = data[offset + 2] = brightness;
                data[offset + 3] = alpha;
            }
        }
    };
    // Broadleaf twigs: an irregular oval of overlapping leaflets, with holes
    // between branches and a serrated silhouette rather than one solid crown.
    for (let i = 0; i < 88; i++) {
        const angle = i * 2.399963;
        const radius = Math.sqrt(noise(i + 2));
        ellipse(64 + Math.cos(angle) * radius * 48, 72 + Math.sin(angle) * radius * 42,
            6 + noise(i + 10) * 7, 3.5 + noise(i + 40) * 3, angle, 190 + noise(i + 71) * 44);
    }
    // Conifer sprays taper upwards and leave gaps between their branch tiers.
    for (let tier = 0; tier < 8; tier++) {
        const cy = 27 + tier * 12;
        const spread = 46 - tier * 5;
        for (let side = -1; side <= 1; side += 2) {
            for (let leaf = 0; leaf < 6; leaf++) {
                const t = (leaf + 0.5) / 6;
                ellipse(192 + side * spread * t, cy + t * 8,
                    7 + noise(tier * 9 + leaf) * 3, 4.5, side * 0.6,
                    188 + noise(tier * 7 + leaf) * 48);
            }
        }
    }
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
    return texture;
}

/** Branches and leaf sprays merge into one geometry: same forest draw count. */
export function createTreeGeometry(kind, foliage, lowPower = false) {
    const parts = [];
    const leafColor = new THREE.Color(foliage);
    const trunkColor = new THREE.Color(0x4a3728);
    const add = (source, canopy, shade) => {
        const geometry = source.index ? source.toNonIndexed() : source;
        if (geometry !== source) source.dispose();
        const count = geometry.attributes.position.count;
        const colors = new Float32Array(count * 3);
        const color = (canopy ? leafColor : trunkColor).clone().multiplyScalar(shade);
        for (let i = 0; i < count; i++) {
            colors.set([color.r, color.g, color.b], i * 3);
            if (!canopy) geometry.attributes.uv.setXY(i, 0.25, 0.025);
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('aCanopy', new THREE.BufferAttribute(new Float32Array(count).fill(canopy ? 1 : 0), 1));
        parts.push(geometry);
    };
    const branch = (from, to, radius, tip = radius * 0.45) => {
        const a = new THREE.Vector3(...from);
        const b = new THREE.Vector3(...to);
        const direction = b.clone().sub(a);
        const geometry = new THREE.CylinderGeometry(tip, radius, direction.length(), 5, 1, true);
        geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize()));
        geometry.translate(...a.add(b).multiplyScalar(0.5).toArray());
        add(geometry, false, 0.9);
    };
    const spray = (x, y, z, width, height, yaw, tilt, shade) => {
        const geometry = new THREE.PlaneGeometry(width, height);
        const uv = geometry.attributes.uv;
        const cell = kind === 'conifer' ? 1 : 0;
        for (let i = 0; i < uv.count; i++) {
            // Inset half a texel to keep the neighbouring atlas cell out.
            uv.setXY(i, cell * 0.5 + 0.004 + uv.getX(i) * 0.492,
                LEAF_UV_BOTTOM + uv.getY(i) * (1 - LEAF_UV_BOTTOM - 0.008));
        }
        geometry.rotateX(tilt);
        geometry.rotateY(yaw);
        geometry.translate(x, y, z);
        // Rounded canopy lighting conceals the flat cards. Back faces are
        // corrected in the fragment hook; trunk normals remain untouched.
        const normals = geometry.attributes.normal;
        const positions = geometry.attributes.position;
        const normal = new THREE.Vector3();
        for (let i = 0; i < normals.count; i++) {
            normal.set(positions.getX(i) * 0.22, 0.8, positions.getZ(i) * 0.22).normalize();
            normals.setXYZ(i, normal.x, normal.y, normal.z);
        }
        add(geometry, true, shade);
    };

    if (kind === 'conifer') {
        branch([0, 0, 0], [0, 9.5, 0], 0.3, 0.035);
        const tiers = lowPower ? 5 : 7;
        const perTier = 4;
        for (let tier = 0; tier < tiers; tier++) {
            const t = tier / (tiers - 1);
            const y = 3.1 + t * 5.5;
            const span = 4.7 - t * 3.2;
            for (let j = 0; j < perTier; j++) {
                const yaw = j * Math.PI / perTier + tier * 0.67;
                spray(0.15 * Math.sin(tier), y, 0.1 * Math.cos(tier), span, 3 - t,
                    yaw, (noise(tier + j) - 0.5) * 0.5, 0.8 + t * 0.2);
            }
        }
    } else {
        const shrub = kind === 'shrub';
        if (!shrub) {
            branch([0, 0, 0], [0.12, 6.8, 0.1], 0.34, 0.065);
            for (let i = 0; i < 3; i++) {
                const yaw = i * 2.399963;
                branch([0, 2.8 + i * 0.6, 0], [Math.sin(yaw) * 1.9, 5.2 + i * 0.8, Math.cos(yaw) * 1.9], 0.14);
            }
        }
        const count = shrub ? (lowPower ? 6 : 10) : (lowPower ? 12 : 22);
        for (let i = 0; i < count; i++) {
            const t = (i + 0.5) / count;
            const yaw = i * 2.399963;
            const radius = Math.sqrt(1 - Math.pow(t * 2 - 1, 2));
            const x = Math.sin(yaw) * radius * (shrub ? 1.05 : 1.8);
            const z = Math.cos(yaw) * radius * (shrub ? 0.75 : 1.6);
            const y = shrub ? 0.55 + t * 0.8 : 3.7 + t * 3.9;
            const width = (shrub ? 1.9 : 3.2) * (0.9 + noise(i + 80) * 0.2);
            // Two crossing sprays per cluster retain volume from every yaw.
            for (let cross = 0; cross < 2; cross++) {
                spray(x, y, z, width, width * (shrub ? 0.65 : 0.85), yaw + cross * Math.PI / 2,
                    (noise(i + 17) - 0.5) * 1.1, 0.78 + t * 0.22);
            }
        }
    }
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    geometry.computeBoundingSphere();
    return geometry;
}

/** Leaf clusters keep their rounded normals on both sides, unlike bark. */
export function patchCanopyNormals(material) {
    applyPatch(material, {
        name: 'canopy-normals',
        vertexHead: 'attribute float aCanopy;\nvarying float vCanopy;',
        vertexMain: 'vCanopy = aCanopy;',
        fragmentHead: 'varying float vCanopy;',
        replace: [['normal_fragment_begin', `#include <normal_fragment_begin>
            #ifdef DOUBLE_SIDED
                normal *= mix(1.0, faceDirection, vCanopy);
                nonPerturbedNormal = normal;
            #endif`]],
    });
}
