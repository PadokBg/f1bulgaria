import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const UP = new THREE.Vector3(0, 1, 0);
const IVORY = 0xe4e0d3;
const CHARCOAL = 0x25292e;
const RED = 0xc52d32;

/**
 * Gloves grip the wheel in its local coordinates. Sleeves live in an unrotated
 * sibling frame with the same position/scale; their endpoints follow the wrists.
 * Three draws, baked shading, no textures. The cockpit owns the shared material.
 */
export function createCockpitHands({ lowPower = false, material } = {}) {
    const hands = new THREE.Group();
    hands.name = 'cockpit-driver-hands';
    const forearms = new THREE.Group();
    forearms.name = 'cockpit-driver-forearms';
    const geometries = new Set();
    const parts = [];
    const joints = [];
    const radial = lowPower ? 5 : 8;
    const sphereSegments = lowPower ? 8 : 12;
    const sphereRings = lowPower ? 5 : 8;
    const curveSegments = lowPower ? 5 : 9;
    const direction = new THREE.Vector3();
    let disposed = false;

    const ball = (side, position, scale, color) => {
        const geometry = new THREE.SphereGeometry(1, sphereSegments, sphereRings);
        geometry.scale(...scale).translate(side * position[0], position[1], position[2]);
        parts.push(tinted(geometry, color));
    };
    const line = (side, points, radius, color, detail = false) => {
        const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(side * x, y, z)));
        parts.push(tinted(new THREE.TubeGeometry(curve,
            detail ? (lowPower ? 3 : 6) : curveSegments,
            radius, detail ? 4 : radial, false), color));
    };

    for (const side of [-1, 1]) {
        const name = side < 0 ? 'left' : 'right';
        // Rounded fabric cuffs meet the sleeves without a hollow ring or an
        // exposed mechanical-looking wrist. Draw them behind the palm.
        ball(side, [0.251, -0.091, 0.084], [0.034, 0.028, 0.030], 0xcac8bf);
        ball(side, [0.251, -0.101, 0.087], [0.034, 0.007, 0.029], RED);
        ball(side, [0.249, -0.016, 0.074], [0.036, 0.064, 0.031], 0x777b75);
        for (let finger = 0; finger < 4; finger++) {
            const y = 0.045 - finger * 0.026;
            const length = finger === 3 ? 0.007 : 0;
            // Suede remains on the far side of the curled fingertip. The
            // visible knuckles and finger backs are one padded ivory glove.
            line(side, [[0.204 + length, y + 0.002, 0.065],
                [0.193 + length, y - 0.006, 0.033]], 0.010, CHARCOAL);
            line(side, [
                [0.253, y, 0.093], [0.231, y + 0.005, 0.103],
                [0.210 + length, y + 0.003, 0.092], [0.202 + length, y - 0.001, 0.066],
            ], finger === 3 ? 0.011 : 0.0125, IVORY);
        }

        // Camera-space solids deliberately disable depth testing. Paint the
        // broad dorsal panel after finger roots so fabric joins continuously.
        ball(side, [0.254, -0.015, 0.097], [0.032, 0.062, 0.024], IVORY);
        // Short open creases suggest soft knuckle folds without separate hard
        // discs. Fine seams use fewer sides than the finger volumes themselves.
        for (let finger = 0; finger < 4; finger++) {
            const y = 0.045 - finger * 0.026;
            line(side, [[0.221, y - 0.006, 0.112], [0.229, y - 0.008, 0.116],
                [0.238, y - 0.006, 0.112]], 0.0006, 0xb1b0a3, true);
        }
        for (let finger = 0; finger < 3; finger++) {
            const y = 0.031 - finger * 0.026;
            line(side, [[0.212, y, 0.102], [0.220, y - 0.001, 0.109],
                [0.229, y + 0.001, 0.113]], 0.0008, 0x8e9389, true);
        }

        // A short opposing thumb curls around the inner grip. Only its small
        // underside is suede; its padded back shares the glove's fabric.
        ball(side, [0.193, 0.018, 0.076], [0.012, 0.015, 0.011], CHARCOAL);
        line(side, [[0.236, -0.043, 0.092], [0.213, -0.031, 0.107],
            [0.195, -0.008, 0.104], [0.193, 0.020, 0.088]], 0.0145, IVORY);
        ball(side, [0.194, 0.019, 0.089], [0.014, 0.014, 0.012], IVORY);
        line(side, [[0.212, -0.033, 0.118], [0.202, -0.021, 0.120],
            [0.197, -0.010, 0.118]], 0.0007, 0xa5a69a, true);
        line(side, [[0.268, 0.034, 0.111], [0.279, -0.020, 0.112],
            [0.264, -0.064, 0.110]], 0.001, 0x858d83, true);
        line(side, [[0.266, 0.034, 0.113], [0.277, -0.020, 0.114],
            [0.262, -0.064, 0.112]], 0.00055, 0xf4efdf, true);
        // A small sewn chevron follows the convex dorsal panel; cuff stitching
        // ties the pale glove into the dark suit without adding a texture.
        line(side, [[0.256, 0.016, 0.121], [0.263, 0.006, 0.123],
            [0.257, -0.036, 0.123]], 0.0018, RED, true);
        line(side, [[0.263, 0.012, 0.119], [0.268, 0.002, 0.121],
            [0.263, -0.030, 0.120]], 0.0007, RED, true);
        line(side, [[0.230, -0.085, 0.108], [0.250, -0.089, 0.115],
            [0.271, -0.085, 0.108]], 0.001, 0x7c827a, true);
        line(side, [[0.230, -0.082, 0.109], [0.250, -0.086, 0.117],
            [0.271, -0.082, 0.109]], 0.00055, 0xf4efdf, true);

        const wrist = new THREE.Object3D();
        wrist.name = `driver-${name}-wrist`;
        wrist.position.set(side * 0.251, -0.108, 0.087);
        hands.add(wrist);

        const geometry = sleeveGeometry(side, lowPower);
        geometries.add(geometry);
        const sleeve = new THREE.Mesh(geometry, material);
        sleeve.name = `driver-${name}-forearm`;
        sleeve.renderOrder = 102;
        sleeve.frustumCulled = false;
        sleeve.position.set(side * 0.30, -0.36, 0.14);
        forearms.add(sleeve);
        joints.push({ wrist, sleeve });
    }

    const glovesGeometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    geometries.add(glovesGeometry);
    glovesGeometry.computeBoundingSphere();
    const gloves = new THREE.Mesh(glovesGeometry, material);
    gloves.name = 'driver-racing-gloves';
    gloves.renderOrder = 106;
    gloves.frustumCulled = false;
    hands.add(gloves);

    function update(angle = 0) {
        if (disposed) return;
        const safeAngle = Number.isFinite(angle) ? angle : 0;
        const cos = Math.cos(safeAngle);
        const sin = Math.sin(safeAngle);
        for (const { wrist, sleeve } of joints) {
            const { x, y, z } = wrist.position;
            direction.set(x * cos - y * sin, x * sin + y * cos, z).sub(sleeve.position);
            const length = direction.length();
            sleeve.scale.y = length;
            sleeve.quaternion.setFromUnitVectors(UP, direction.multiplyScalar(1 / length));
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        hands.removeFromParent();
        forearms.removeFromParent();
        for (const geometry of geometries) geometry.dispose();
        geometries.clear();
        hands.clear();
        forearms.clear();
    }

    update(0);
    return { hands, forearms, update, dispose };
}

function sleeveGeometry(side, lowPower) {
    const profile = [[0, 0], [0.042, 0], [0.047, 0.07], [0.046, 0.32],
        [0.040, 0.61], [0.0405, 0.68], [0.037, 0.74],
        [0.033, 0.88], [0.034, 0.91], [0.030, 0.96], [0.029, 1], [0, 1]];
    const source = new THREE.LatheGeometry(profile.map(([radius, y]) => new THREE.Vector2(radius, y)), lowPower ? 8 : 14);
    const geometry = source.toNonIndexed();
    source.dispose();
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const color = new THREE.Color();
    const colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
        const front = normal.getZ(i);
        const outer = normal.getX(i) * side;
        // Match the authored profile rings despite Float32 storage rounding.
        const y = Math.round(position.getY(i) * 1000) / 1000;
        color.setHex(front > 0.45 ? 0x41444a : CHARCOAL);
        if (front > 0.15 && outer > 0.72) color.setHex(RED);
        if (front > 0.78 && outer > 0.32) color.setHex(0x777973);
        if (y >= 0.91) color.setHex(0xcac8bf);
        if (y >= 0.88 && y < 0.91) color.setHex(0x1a1e24);
        const fold = y >= 0.68 && y <= 0.74 ? 0.82 : 1;
        const light = (0.53 + Math.max(0, front) * 0.40 + Math.max(0, normal.getY(i)) * 0.07) * fold;
        colors[i * 3] = color.r * light;
        colors[i * 3 + 1] = color.g * light;
        colors[i * 3 + 2] = color.b * light;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.clearGroups();
    geometry.computeBoundingSphere();
    return geometry;
}

function tinted(source, hex) {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    const color = new THREE.Color(hex);
    const normal = geometry.attributes.normal;
    const colors = new Float32Array(normal.count * 3);
    for (let i = 0; i < normal.count; i++) {
        const light = 0.46 + Math.max(0, normal.getZ(i)) * 0.40 + Math.max(0, normal.getY(i)) * 0.14;
        colors[i * 3] = color.r * light;
        colors[i * 3 + 1] = color.g * light;
        colors[i * 3 + 2] = color.b * light;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.clearGroups();
    return geometry;
}
