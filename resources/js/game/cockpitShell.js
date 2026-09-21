import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Camera-space tub lining: two draws, one small static weave, no scene lights. */
export function createCockpitShell({ lowPower = false, material } = {}) {
    const group = new THREE.Group();
    group.name = 'cockpit-inner-shell';
    const carbon = [];
    const trim = [];
    const resources = [];
    let disposed = false;

    // A recessed bulkhead covers the GLB's baked-in controls behind our wheel.
    // Side panels open towards the driver's shoulders rather than the road.
    carbon.push(surface([
        [-0.57, -0.133, -0.86], [-0.48, -0.084, -0.91],
        [0.48, -0.084, -0.91], [0.57, -0.133, -0.86],
        [0.43, -0.48, -0.56], [-0.43, -0.48, -0.56],
    ], 0.78));
    for (const side of [-1, 1]) {
        const mirror = points => points.map(([x, y, z]) => [side * x, y, z]);
        carbon.push(surface(mirror([
            [0.57, -0.133, -0.86], [0.78, -0.148, -0.70],
            [1.12, -0.16, -0.47], [0.88, -0.53, -0.33],
            [0.43, -0.48, -0.56],
        ]), 0.93));
        // A second angled ledge catches more light than the deep inner wall.
        carbon.push(surface(mirror([
            [0.57, -0.133, -0.86], [0.60, -0.113, -0.86],
            [0.81, -0.125, -0.70], [1.15, -0.135, -0.47],
            [1.12, -0.16, -0.47], [0.78, -0.148, -0.70],
        ]), 1.25));

        const rail = mirror([[0.56, -0.12, -0.855], [0.79, -0.14, -0.69], [1.13, -0.15, -0.46]]);
        trim.push(shaded(tube(rail, 0.018, lowPower ? 8 : 14), 0x333b44));
        trim.push(shaded(tube(mirror([[0.585, -0.102, -0.855], [0.805, -0.118, -0.69],
            [1.145, -0.127, -0.46]]), 0.0027, lowPower ? 8 : 14), 0xa2393c));
        // Recessed seam and its narrow stitched edge define the soft side pad.
        const seam = mirror([[0.61, -0.185, -0.81], [0.75, -0.21, -0.66], [0.99, -0.24, -0.43]]);
        trim.push(shaded(tube(seam, 0.004, 8), 0x111820));
        trim.push(shaded(tube(seam.map(([x, y, z]) => [x, y - 0.006, z + 0.003]), 0.0014, 8), 0x626a70));

        // Flush fasteners stay at the sides, clear of the telemetry and hands.
        for (const [x, y, z] of [[0.46, -0.166, -0.836], [0.57, -0.31, -0.69]]) {
            trim.push(shaded(new THREE.CylinderGeometry(0.009, 0.009, 0.003, 8)
                .rotateX(Math.PI / 2).translate(side * x, y, z), 0x818d96));
            trim.push(shaded(new THREE.BoxGeometry(0.009, 0.0018, 0.002)
                .translate(side * x, y, z + 0.003), 0x18212a));
        }
    }
    // Dark floor closes the lower view without adding decorative instruments.
    carbon.push(surface([[-0.43, -0.48, -0.56], [0.43, -0.48, -0.56],
        [0.48, -0.63, -0.32], [-0.48, -0.63, -0.32]], 0.42));
    const frontLip = [[-0.57, -0.133, -0.851], [-0.48, -0.084, -0.901],
        [0.48, -0.084, -0.901], [0.57, -0.133, -0.851]];
    for (let i = 1; i < frontLip.length; i++) {
        trim.push(shaded(tube([frontLip[i - 1], frontLip[i]], 0.007, 3), 0x4d5861));
    }

    const weave = weaveTexture();
    const carbonMaterial = new THREE.MeshBasicMaterial({
        map: weave, vertexColors: true, side: THREE.DoubleSide, forceSinglePass: true,
        transparent: true, depthTest: false, depthWrite: false,
        toneMapped: false, fog: false,
    });
    resources.push(weave, carbonMaterial);
    addMerged(carbon, carbonMaterial, 'cockpit-carbon-tub', 98.5);
    addMerged(trim, material, 'cockpit-padded-rim', 99);

    function addMerged(parts, surfaceMaterial, name, renderOrder) {
        const geometry = mergeGeometries(parts, false);
        parts.forEach(part => part.dispose());
        geometry.computeBoundingSphere();
        resources.push(geometry);
        const mesh = new THREE.Mesh(geometry, surfaceMaterial);
        mesh.name = name;
        mesh.renderOrder = renderOrder;
        mesh.frustumCulled = false;
        group.add(mesh);
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        group.removeFromParent();
        resources.forEach(resource => resource.dispose());
        group.clear();
    }

    return { group, dispose };
}

/** Convex panel fan, with continuous weave coordinates in camera space. */
function surface(points, brightness) {
    const positions = [];
    const uv = [];
    const colors = [];
    for (let i = 1; i < points.length - 1; i++) {
        for (const [x, y, z] of [points[0], points[i], points[i + 1]]) {
            positions.push(x, y, z);
            uv.push(x * 20, (y + z * 0.3) * 20);
            const light = brightness * (0.65 + Math.max(0, y + 0.55));
            colors.push(light * 0.84, light * 0.91, light);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    return geometry;
}

function tube(points, radius, segments) {
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), segments, radius, 6, false);
}

function shaded(source, hex) {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    const color = new THREE.Color(hex);
    const normal = geometry.attributes.normal;
    const colors = new Float32Array(normal.count * 3);
    for (let i = 0; i < normal.count; i++) {
        const light = 0.45 + Math.max(0, normal.getY(i)) * 0.35 + Math.max(0, normal.getZ(i)) * 0.2;
        colors.set([color.r * light, color.g * light, color.b * light], i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.clearGroups();
    return geometry;
}

function weaveTexture() {
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const horizontal = ((Math.floor(x / 8) - Math.floor(y / 8) + 64) % 4) < 2;
            const thread = (horizontal ? y : x) % 2;
            const value = (horizontal ? 43 : 37) + thread * 3 + (x * 17 + y * 31) % 3;
            const index = (y * size + x) * 4;
            data.set([value - 3, value, value + 4, 255], index);
        }
    }
    const texture = new THREE.DataTexture(data, size, size);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}
