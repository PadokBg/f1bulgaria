import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { REDLINE, SHIFT_RPM } from './drivetrain.js';
import { createCockpitHands } from './cockpitHands.js';
import { createCockpitShell } from './cockpitShell.js';

const DISPLAY_INTERVAL = 0.1;
const WHEEL_DEPTH = 0.62;
const BASE_HALF_HEIGHT = 0.32;
const PANEL_BOUNDS = { left: -0.18, right: 0.18, bottom: -0.115, top: 0.125 };

/**
 * Camera-space cockpit. The real car supplies the exterior/halo; this small
 * assembly supplies a readable steering wheel at the driver's near plane.
 * Eleven draws including the driver's hands, no lights or external assets.
 * Solid pieces share one material.
 *
 * @param {{lowPower?: boolean}} [options]
 * @returns {{group: THREE.Group, steeringWheel: THREE.Group, update: Function, dispose: Function}}
 */
export function createCockpit({ lowPower = false } = {}) {
    const group = new THREE.Group();
    group.name = 'cockpit-interior';
    const steeringWheel = new THREE.Group();
    steeringWheel.name = 'cockpit-steering-wheel';
    group.add(steeringWheel);

    const resources = new Set();
    const own = resource => { resources.add(resource); return resource; };
    const solid = own(new THREE.MeshBasicMaterial({
        vertexColors: true,
        // Join the late transparent queue so smoke/ghosts stay behind the
        // cockpit; depth testing alone cannot order opaque vs transparent.
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false,
    }));
    const segments = lowPower ? 8 : 12;
    const body = [];
    const grips = [];
    const controls = [];

    const bodyShape = wheelShape();
    body.push(tinted(extrude(bodyShape, 0.025), 0x52606c));
    // Paddle edges sit behind the rim, using the same merged shell draw.
    for (const side of [-1, 1]) {
        const paddle = box(0.031, 0.13, 0.007, side * 0.172, 0.005, -0.019);
        body.push(tinted(paddle, 0x707c87));
        body.push(tinted(box(0.022, 0.119, 0.008, side * 0.172, 0.005, -0.014), 0x242c33));
    }
    // Thin alloy backing and screen bezel provide depth without a lit material.
    controls.push(tinted(box(0.183, 0.135, 0.009, 0, 0.034, 0.028), 0x4a555f));
    controls.push(tinted(box(0.176, 0.128, 0.012, 0, 0.034, 0.034), 0x090d11));

    for (const side of [-1, 1]) {
        const grip = extrude(gripShape(side), 0.052);
        grip.translate(0, 0, -0.01);
        grips.push(tinted(grip, 0x20252a));
        // Raised thumb rests and a muted seam define the rubber silhouette.
        const rest = new THREE.SphereGeometry(0.022, segments, 5);
        rest.scale(0.68, 1.25, 0.65);
        rest.translate(side * 0.182, 0.041, 0.047);
        grips.push(tinted(rest, 0x2d343b));
        for (const y of [-0.062, -0.037, -0.012]) {
            const seam = box(0.025, 0.0025, 0.002, side * 0.215, y, 0.049);
            grips.push(tinted(seam, 0x3b4146));
        }

        for (const y of [0.085, -0.09]) {
            controls.push(tinted(disc(0.0045, 0.003, side * 0.114, y, 0.03, 6), 0x909a9f));
            controls.push(tinted(box(0.0045, 0.0011, 0.001, side * 0.114, y, 0.034), 0x18222c));
        }
    }

    const buttons = [
        [-0.141, 0.06, 0x48a7d4], [0.141, 0.06, 0x66d193],
        [-0.15, -0.007, 0xf2bc42], [0.15, -0.007, 0x6485df],
        [-0.143, -0.073, 0xde514b], [0.143, -0.073, 0x49b6a8],
    ];
    for (const [x, y, color] of buttons) {
        controls.push(tinted(disc(0.0165, 0.007, x, y, 0.031, segments), 0x727b83));
        controls.push(tinted(disc(0.0145, 0.008, x, y, 0.033, segments), 0x10171e));
        controls.push(tinted(disc(0.012, 0.01, x, y, 0.038, segments), color));
        controls.push(tinted(box(0.009, 0.0018, 0.001, x, y + 0.005, 0.044), 0xd9e7eb));
    }
    for (const [x, color] of [[-0.057, 0xe46c54], [0.057, 0xd9b04c]]) {
        controls.push(tinted(disc(0.024, 0.008, x, -0.071, 0.032, segments), 0x7a8388));
        controls.push(tinted(disc(0.02, 0.012, x, -0.071, 0.043, 10), color));
        for (let i = 0; i < 10; i++) {
            const angle = i * Math.PI / 5;
            const notch = new THREE.BoxGeometry(0.002, 0.005, 0.002);
            notch.rotateZ(-angle).translate(x + Math.sin(angle) * 0.018, -0.071 + Math.cos(angle) * 0.018, 0.05);
            controls.push(tinted(notch, 0x263039));
        }
        controls.push(tinted(box(0.003, 0.014, 0.002, x, -0.066, 0.05), 0x172029));
    }

    addMerged(steeringWheel, 'cockpit-wheel-body', body, 100);
    addMerged(steeringWheel, 'cockpit-wheel-grips', grips, 103);
    addMerged(steeringWheel, 'cockpit-wheel-controls', controls, 104);

    const panelCanvas = makeCanvas(lowPower ? 512 : 1024, lowPower ? 320 : 640);
    if (panelCanvas) drawPanel(panelCanvas.context, lowPower ? 1 : 2);
    const panelTexture = own(textureFromCanvas(panelCanvas?.canvas, [25, 29, 33, 255], true));
    const panelMaterial = own(panelMaterialFor(panelTexture));
    const face = own(new THREE.ShapeGeometry(bodyShape, 6));
    const positions = face.attributes.position;
    const uv = face.attributes.uv;
    for (let i = 0; i < positions.count; i++) {
        uv.setXY(i,
            (positions.getX(i) - PANEL_BOUNDS.left) / (PANEL_BOUNDS.right - PANEL_BOUNDS.left),
            (positions.getY(i) - PANEL_BOUNDS.bottom) / (PANEL_BOUNDS.top - PANEL_BOUNDS.bottom));
    }
    const faceMesh = new THREE.Mesh(face, panelMaterial);
    faceMesh.name = 'cockpit-carbon-panel';
    faceMesh.position.z = 0.027;
    faceMesh.renderOrder = 101;
    faceMesh.frustumCulled = false;
    steeringWheel.add(faceMesh);

    const displayCanvas = makeCanvas(lowPower ? 256 : 512, lowPower ? 160 : 320);
    const displayTexture = own(textureFromCanvas(displayCanvas?.canvas, [7, 14, 19, 255]));
    const displayMaterial = own(panelMaterialFor(displayTexture));
    const display = new THREE.Mesh(own(new THREE.PlaneGeometry(0.167, 0.118)), displayMaterial);
    display.name = 'cockpit-telemetry';
    display.position.set(0, 0.035, 0.047);
    display.renderOrder = 105;
    display.frustumCulled = false;
    steeringWheel.add(display);

    const driver = createCockpitHands({ lowPower, material: solid });
    driver.hands.name = 'cockpit-driver-hands';
    driver.forearms.name = 'cockpit-driver-forearms';
    steeringWheel.add(driver.hands);
    group.add(driver.forearms);

    const interior = createCockpitShell({ lowPower, material: solid });
    const surround = interior.group;
    group.add(surround);

    const fallbackHalo = new THREE.Group();
    fallbackHalo.name = 'cockpit-fallback-halo';
    group.add(fallbackHalo);
    addMerged(fallbackHalo, 'cockpit-fallback-halo-frame', [
        tinted(tube([[-0.79, 0.20, -1.12], [-0.48, 0.31, -1.38], [0, 0.34, -1.53],
            [0.48, 0.31, -1.38], [0.79, 0.20, -1.12]], 0.017, lowPower ? 16 : 24), 0x242c33),
        tinted(tube([[0, -0.19, -1.35], [0, 0.05, -1.44], [0, 0.34, -1.53]], 0.011, 8), 0x1a2026),
    ], 98);

    let elapsed = DISPLAY_INTERVAL;
    let lastDisplay = '';
    let disposed = false;

    /** Camera owns steeringWheel.rotation.z; presentation never overwrites it. */
    function update({ speedKph = 0, gear, rpm = 0, aspect = 16 / 9, fov = 55, hasModel = false } = {}, dt = 1 / 60) {
        if (disposed) return;
        const safeAspect = finiteClamp(aspect, 0.35, 4, 16 / 9);
        const halfHeight = Math.tan(THREE.MathUtils.degToRad(finiteClamp(fov, 25, 110, 55)) / 2) * WHEEL_DEPTH;
        // The lining follows the body in a wide vertical FOV. A constant screen
        // height in portrait would expose the GLB's old controls above it.
        const liningHalfHeight = Math.tan(THREE.MathUtils.degToRad(finiteClamp(fov, 25, 150, 55)) / 2) * WHEEL_DEPTH;
        const scale = Math.min(halfHeight / BASE_HALF_HEIGHT, halfHeight * safeAspect / 0.29) * 0.8;
        steeringWheel.scale.setScalar(scale);
        steeringWheel.position.set(0, -halfHeight * 0.52, -WHEEL_DEPTH);
        // Fingers keep contact with the wheel while elbows stay down beside
        // the seat. Update every frame, independently of the display throttle.
        driver.forearms.position.copy(steeringWheel.position);
        driver.forearms.scale.copy(steeringWheel.scale);
        driver.update(steeringWheel.rotation.z);
        surround.scale.set(liningHalfHeight / BASE_HALF_HEIGHT, Math.min(1.25, liningHalfHeight / BASE_HALF_HEIGHT), 1);
        fallbackHalo.scale.set(halfHeight / BASE_HALF_HEIGHT, halfHeight / BASE_HALF_HEIGHT, 1);
        fallbackHalo.visible = !hasModel;

        elapsed = Math.min(DISPLAY_INTERVAL, elapsed + finiteClamp(dt, 0, 1, 0));
        if (!displayCanvas || elapsed + 1e-6 < DISPLAY_INTERVAL) return;
        const speed = Math.round(finiteClamp(speedKph, 0, 999, 0));
        const rpmValue = Math.round(finiteClamp(rpm, 0, REDLINE, 0) / 100) * 100;
        const gearLabel = Number.isFinite(gear) ? (gear <= 0 ? 'R' : String(Math.min(8, Math.round(gear)))) : 'N';
        const key = `${speed}/${gearLabel}/${rpmValue}`;
        if (key === lastDisplay) return;
        drawDisplay(displayCanvas.context, displayCanvas.canvas.width / 512, speed, gearLabel, rpmValue);
        displayTexture.needsUpdate = true;
        lastDisplay = key;
        elapsed = 0;
    }

    function addMerged(parent, name, parts, renderOrder) {
        const geometry = own(mergeGeometries(parts, false));
        for (const part of parts) part.dispose();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, solid);
        mesh.name = name;
        mesh.renderOrder = renderOrder;
        mesh.frustumCulled = false;
        parent.add(mesh);
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        group.removeFromParent();
        driver.dispose();
        interior.dispose();
        for (const resource of resources) resource.dispose();
        resources.clear();
        group.clear();
    }

    steeringWheel.position.set(0, -0.26, -WHEEL_DEPTH);
    return { group, steeringWheel, update, dispose };
}

function wheelShape() {
    const shape = new THREE.Shape();
    shape.moveTo(-0.164, 0.087);
    shape.quadraticCurveTo(-0.144, 0.122, -0.112, 0.122);
    shape.lineTo(0.112, 0.122);
    shape.quadraticCurveTo(0.144, 0.122, 0.164, 0.087);
    shape.lineTo(0.177, -0.068);
    shape.quadraticCurveTo(0.174, -0.103, 0.132, -0.107);
    shape.lineTo(0.067, -0.107);
    shape.lineTo(0.045, -0.091);
    shape.lineTo(-0.045, -0.091);
    shape.lineTo(-0.067, -0.107);
    shape.lineTo(-0.132, -0.107);
    shape.quadraticCurveTo(-0.174, -0.103, -0.177, -0.068);
    shape.closePath();
    return shape;
}

function gripShape(side) {
    const shape = new THREE.Shape();
    shape.moveTo(side * 0.173, 0.091);
    shape.quadraticCurveTo(side * 0.206, 0.12, side * 0.231, 0.068);
    shape.quadraticCurveTo(side * 0.25, -0.022, side * 0.214, -0.101);
    shape.quadraticCurveTo(side * 0.198, -0.137, side * 0.169, -0.104);
    shape.lineTo(side * 0.187, -0.041);
    shape.quadraticCurveTo(side * 0.20, 0.02, side * 0.173, 0.053);
    shape.closePath();
    return shape;
}

function extrude(shape, depth) {
    return new THREE.ExtrudeGeometry(shape, {
        depth, bevelEnabled: true, bevelSegments: 1, steps: 1,
        bevelSize: 0.004, bevelThickness: 0.004, curveSegments: 5,
    });
}

function box(w, h, d, x, y, z) {
    return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function disc(radius, depth, x, y, z, segments) {
    return new THREE.CylinderGeometry(radius, radius, depth, segments)
        .rotateX(Math.PI / 2).translate(x, y, z);
}

function tube(points, radius, segments) {
    const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)));
    return new THREE.TubeGeometry(curve, segments, radius, 5, false);
}

/** Baked soft directional shading avoids extra cockpit lights/shader variants. */
function tinted(source, hex) {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    const color = new THREE.Color(hex);
    const normal = geometry.attributes.normal;
    const colors = new Float32Array(normal.count * 3);
    for (let i = 0; i < normal.count; i++) {
        const light = 0.40 + Math.max(0, normal.getZ(i)) * 0.43
            + Math.max(0, normal.getY(i)) * 0.22 + Math.max(0, -normal.getX(i)) * 0.07;
        colors[i * 3] = color.r * light;
        colors[i * 3 + 1] = color.g * light;
        colors[i * 3 + 2] = color.b * light;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.clearGroups();
    return geometry;
}

function makeCanvas(width, height) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    return context ? { canvas, context } : null;
}

function textureFromCanvas(canvas, rgba, staticSurface = false) {
    const texture = canvas ? new THREE.CanvasTexture(canvas) : new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = staticSurface;
    texture.minFilter = staticSurface ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}

function panelMaterialFor(map) {
    return new THREE.MeshBasicMaterial({ map, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
}

function drawPanel(ctx, scale) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.fillStyle = '#252c32';
    ctx.fillRect(0, 0, 512, 320);
    // Alternating diagonal bundles give the weave depth without a normal map.
    for (let y = 0; y < 320; y += 4) {
        for (let x = 0; x < 512; x += 4) {
            const horizontal = ((x / 4 - y / 4 + 160) % 4) < 2;
            ctx.fillStyle = horizontal ? '#293139' : '#192128';
            ctx.fillRect(x, y, 3.5, 3.5);
            ctx.fillStyle = horizontal ? '#343d43' : '#242d34';
            for (let thread = 1; thread < 4; thread += 1.5) {
                ctx.fillRect(x + (horizontal ? 0 : thread), y + (horizontal ? thread : 0), horizontal ? 3.5 : 0.4, horizontal ? 0.4 : 3.5);
            }
        }
    }
    const satin = ctx.createLinearGradient(0, 0, 470, 320);
    satin.addColorStop(0, 'rgba(156, 177, 194, 0.14)');
    satin.addColorStop(0.35, 'rgba(3, 8, 13, 0.05)');
    satin.addColorStop(1, 'rgba(1, 5, 10, 0.72)');
    ctx.fillStyle = satin;
    ctx.fillRect(0, 0, 512, 320);
    // Lacquered accent and edge highlight follow the flat top of the shell.
    ctx.fillStyle = '#973035';
    roundedRect(ctx, 111, 9, 290, 5, 2);
    ctx.fillStyle = '#e57872';
    ctx.fillRect(132, 9, 248, 1);
    ctx.fillStyle = '#778692';
    ctx.fillRect(180, 19, 152, 1);

    // Engraved rotary scales remain behind their raised physical knobs.
    for (const x of [-0.057, 0.057]) {
        const centerX = (x - PANEL_BOUNDS.left) / 0.36 * 512;
        const centerY = (PANEL_BOUNDS.top + 0.071) / 0.24 * 320;
        ctx.strokeStyle = '#9aa5ab';
        ctx.lineWidth = 1.3;
        for (let i = 0; i < 11; i++) {
            const a = Math.PI * (0.82 + i * 0.137);
            ctx.beginPath();
            ctx.moveTo(centerX + Math.cos(a) * 36, centerY + Math.sin(a) * 34);
            ctx.lineTo(centerX + Math.cos(a) * 40, centerY + Math.sin(a) * 38);
            ctx.stroke();
        }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 12px Arial, sans-serif';
    ctx.fillStyle = '#e0e7eb';
    for (const [label, x, y] of [
        ['RADIO', -0.141, 0.091], ['OT', 0.141, 0.091],
        ['N', -0.15, 0.019], ['PIT', 0.15, 0.019],
        ['BB', -0.057, -0.043], ['DIFF', 0.057, -0.043],
    ]) {
        ctx.fillText(label, (x - PANEL_BOUNDS.left) / 0.36 * 512, (PANEL_BOUNDS.top - y) / 0.24 * 320);
    }
    ctx.font = '700 13px Arial, sans-serif';
    ctx.fillStyle = '#d6dde0';
    ctx.fillText('PADOK', 256, 297);
    ctx.restore();
}

function drawDisplay(ctx, scale, speed, gear, rpm) {
    ctx.save();
    ctx.scale(scale, scale);
    const glass = ctx.createLinearGradient(0, 0, 512, 320);
    glass.addColorStop(0, '#192b34');
    glass.addColorStop(0.5, '#081319');
    glass.addColorStop(1, '#03090d');
    ctx.fillStyle = glass;
    ctx.fillRect(0, 0, 512, 320);
    ctx.fillStyle = '#5c7b88';
    ctx.fillRect(0, 0, 512, 2);
    ctx.fillStyle = '#0a1218';
    roundedRect(ctx, 12, 8, 488, 35, 9);
    const lit = Math.round(THREE.MathUtils.clamp((rpm - 4000) / (SHIFT_RPM - 4000), 0, 1) * 15);
    for (let i = 0; i < 15; i++) {
        const ledColor = i < 5 ? '#41e69e' : i < 10 ? '#fa625b' : '#76b9ff';
        // Canvas glow is baked at the same 10 Hz as telemetry; no bloom pass.
        ctx.shadowColor = ledColor;
        ctx.shadowBlur = i < lit ? 8 : 0;
        ctx.fillStyle = i < lit ? ledColor : '#23313a';
        roundedRect(ctx, 20 + i * 32, 14, 23, 15, 4);
        ctx.shadowBlur = 0;
        ctx.fillStyle = i < lit ? '#d5eeec' : '#33434c';
        ctx.fillRect(23 + i * 32, 16, 17, 2);
    }
    ctx.fillStyle = '#1c333e';
    ctx.fillRect(222, 67, 1, 176);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#aac1cc';
    ctx.font = '600 21px Arial, sans-serif';
    ctx.fillText('GEAR', 31, 66);
    ctx.fillText('KM/H', 271, 66);
    ctx.fillStyle = '#f1fbff';
    ctx.font = '700 166px Arial, sans-serif';
    ctx.fillText(gear, 27, 167);
    ctx.font = '700 90px Arial, sans-serif';
    ctx.fillText(String(speed), 255, 155);
    ctx.fillStyle = '#9bb4c2';
    ctx.font = '600 22px Arial, sans-serif';
    ctx.fillText('RPM', 271, 220);
    ctx.fillStyle = '#d2e8ef';
    ctx.font = '600 30px Arial, sans-serif';
    ctx.fillText(String(rpm), 334, 220);
    ctx.fillStyle = '#314952';
    ctx.fillRect(29, 259, 454, 2);
    ctx.fillStyle = '#48cbae';
    ctx.fillRect(29, 259, 454 * THREE.MathUtils.clamp(rpm / SHIFT_RPM, 0, 1), 2);
    ctx.fillStyle = '#55d6b2';
    ctx.font = '600 18px Arial, sans-serif';
    ctx.fillText('PADOK', 30, 288);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#a1bac8';
    ctx.fillText('RACE', 483, 288);
    ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();
}

function finiteClamp(value, min, max, fallback) {
    return Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : fallback;
}
