/**
 * Ефектите по болида: нажежени спирачни дискове на четирите колела, пламъци
 * от ауспуха при сваляне на предавка/отпускане на газта (с точкова светлина
 * на десктоп), контактна blob сянка, замърсяване на долната част на тялото
 * и heat haze над ауспуха (uHaze на grade pass-а).
 *
 * Един обект на кола (играч, съперници, реплей) — заменя Game.#buildCarLights
 * / #updateCarLights. Всички мешове са тагнати userData.carLight (attachCarModel
 * не ги крие) и висят на пивотите на колелата (дисковете завиват с колелото),
 * на rig.body (ауспух) или на rig.root (blob сянката не се накланя с тялото).
 *
 * Сигналите са истински: спирачка × скорост интегрират топлина по ос (предната
 * поема повече), rpm/предавка идват от drivetrain.js (визуално-звуков слой,
 * нула влияние върху симулацията), настилката — от sim.offSurface.
 * Нищо тук не пише в симулацията.
 */

import * as THREE from 'three';
import { applyPatch } from './materialPatch.js';
import { getNoiseTexture } from './noiseTex.js';
import { REDLINE } from './drivetrain.js';

/**
 * Нагряване по ос: heat += brake·|v|·dt·k. Плановете дават 0.09/0.05 — с тях
 * дискът става бял за 0.15 s от 300 km/h (спирането трае ~2 s); 0.035/0.02
 * дават червено след ~0.3 s и бяло към края на тежко спиране, както по ТВ.
 */
const HEAT_GAIN = { front: 0.035, rear: 0.02 };

/** Охлаждане: heat −= (COOL_BASE + COOL_SPEED·|v|)·heat·dt. */
const COOL_BASE = 0.35;
const COOL_SPEED = 0.012;

/**
 * Съвременен F1 ауспух: видимият пламък е рядък и много кратък при overrun
 * или сваляне на предавка. При подаване на газ и качване на предавка не
 * създаваме пламък.
 */
const FLAME_DOWNSHIFT = 0.035;
const FLAME_POP = 0.028;
const DOWNSHIFT_FLAME_CHANCE = 0.08;
const OVERRUN_FLAME_CHANCE = 0.12;

/** Свещта на ауспуха (десктоп): интензитет при пълен пламък (cd). */
const EXHAUST_LIGHT_INTENSITY = 4;

/**
 * Blob сянка: базова плътност. На телефона (512 PCF, без декор в сенчестия
 * pass) тя Е контактната сянка; на десктоп истинската сянка вече лежи под
 * колата и blob-ът само уплътнява контакта — иначе двете се събират в черно.
 */
const BLOB_OPACITY_DAY = { lowPower: 0.55, desktop: 0.4 };
const BLOB_OPACITY_NIGHT = 0.35;

/** Замърсяване по настилка (1/s) и самопочистване на асфалт (1/s при v ≥ 20). */
const DIRT_GAIN = { gravel: 0.25, sand: 0.2, grass: 0.15 };
const DIRT_IDLE_GAIN = 0.003;
const DIRT_CLEAN = 0.12;

/** Цветове на прахта по настилка (линейни). */
const DIRT_COLORS = {
    gravel: new THREE.Color(0.55, 0.47, 0.36),
    sand: new THREE.Color(0.6, 0.5, 0.34),
    grass: new THREE.Color(0.3, 0.32, 0.18),
};

/** Позиция на heat haze-а спрямо тялото (над ауспуха, назад). */
const HAZE_LOCAL = new THREE.Vector3(0, 0.55, -2.6);

/**
 * @typedef {object} CarEffectsView
 * @property {'chase'|'onboard'} [cameraMode]  Haze само в chase
 * @property {boolean} [replay]                Без haze/pops в реплей
 */

/**
 * @typedef {object} CarEffects
 * @property {(dt: number, state: object, input: {brake: number, throttle: number}|null, drivetrain: {gear: number, rpm: number}|null, surface: {offSurface?: string|null}|string|null, view?: CarEffectsView|null) => void} update
 * @property {(times: number[]) => void} pops   Проблясъци на ауспуха след `times` секунди (от аудиото)
 * @property {(night: boolean) => void} setNight
 * @property {() => number} dirt   Текущото замърсяване 0..1 (за телеметрия)
 * @property {() => void} dispose
 */

/**
 * @param {import('./car.js').CarRig} rig
 * @param {{night?: boolean, lowPower?: boolean, quality?: object|null, isPlayer?: boolean, camera?: THREE.Camera|null, gradePass?: (() => object|null)|object|null, seed?: number}} [options]
 * @returns {CarEffects}
 */
export function createCarEffects(rig, options = {}) {
    const lowPower = options.lowPower === true;
    const isPlayer = options.isPlayer !== false;
    const random = mulberry32(options.seed ?? 0x9e3779b9);
    let night = options.night === true;
    let disposed = false;

    // ── Спирачни дискове ─────────────────────────────────────────────────
    const ringGeometry = new THREE.RingGeometry(0.1, 0.16, 24);
    const ringMaterials = {
        front: makeGlowMaterial(),
        rear: makeGlowMaterial(),
    };
    const spriteMaterials = {
        front: makeHubSpriteMaterial(),
        rear: makeHubSpriteMaterial(),
    };
    /** @type {THREE.Object3D[]} */
    const owned = [];
    /** Греещите мешове по ос — скриват се студени, за да не струват draw call. */
    const glowObjects = { front: [], rear: [] };

    for (const wheel of rig.wheels) {
        if (wheel.far) {
            continue; // далечното LOD колело на съперник — невидимо за ефектите
        }
        const material = ringMaterials[wheel.axle];
        // Двата диска: точно зад външната стена на джантата (вижда се през
        // спиците) и към вътрешната (вижда се отдолу/отзад).
        for (const face of [-1, 1]) {
            const ring = new THREE.Mesh(ringGeometry, material);
            ring.rotation.y = face * (Math.PI / 2);
            ring.position.x = face * (wheel.width / 2 - 0.06);
            ring.userData.carLight = true;
            ring.visible = false;
            wheel.steer.add(ring);
            owned.push(ring);
            glowObjects[wheel.axle].push(ring);
        }
        // Ореол при главината: чете се през процепите на джантата от chase
        // камерата, когато самият диск е под остър ъгъл. С depth test —
        // иначе грее и през понтона, когато колелото е зад тялото.
        const sprite = new THREE.Sprite(spriteMaterials[wheel.axle]);
        sprite.scale.set(0.5, 0.5, 1);
        sprite.userData.carLight = true;
        sprite.visible = false;
        wheel.steer.add(sprite);
        owned.push(sprite);
        glowObjects[wheel.axle].push(sprite);
    }

    const heat = { front: 0, rear: 0 };
    const heatColor = new THREE.Color();

    // ── Ауспух ───────────────────────────────────────────────────────────
    const exhaustPosition = new THREE.Vector3(0, 0.5, rig.axles.rear.z - 0.6);
    const flame = buildFlame();
    flame.position.copy(exhaustPosition);
    flame.userData.carLight = true;
    rig.body.add(flame);
    owned.push(flame);

    let exhaustLight = null;
    if (!lowPower && isPlayer) {
        // Създава се ОТ САМОТО НАЧАЛО (интензитет 0): броят точкови светлини
        // влиза в define-овете на всяка програма — появи ли се по-късно, всеки
        // осветен материал се прекомпилира при първия пламък.
        exhaustLight = new THREE.PointLight(0xff8a30, 0, 4, 2);
        exhaustLight.position.copy(exhaustPosition).add(new THREE.Vector3(0, 0.05, -0.15));
        exhaustLight.userData.carLight = true;
        rig.body.add(exhaustLight);
        owned.push(exhaustLight);
    }

    /** Активни проблясъци: [оставащо забавяне, продължителност]. */
    const flashes = [];
    let flash = 0;
    let prevGear = null;

    // ── Blob сянка ───────────────────────────────────────────────────────
    const blobDay = lowPower ? BLOB_OPACITY_DAY.lowPower : BLOB_OPACITY_DAY.desktop;
    const blob = buildBlobShadow(rig.axles, blobDay);
    blob.userData.carLight = true;
    rig.root.add(blob);
    owned.push(blob);

    // ── Замърсяване ──────────────────────────────────────────────────────
    const dirtUniforms = installDirtPatch(rig);
    let dirt = 0;
    const dirtColor = new THREE.Color().copy(DIRT_COLORS.gravel);

    // ── Heat haze ────────────────────────────────────────────────────────
    const camera = options.camera ?? null;
    const gradePassOf = typeof options.gradePass === 'function' ? options.gradePass : () => options.gradePass ?? null;
    const hazeWorld = new THREE.Vector3();
    const hazeView = new THREE.Vector3();

    /**
     * @param {number} dt
     * @param {object} state
     * @param {{brake: number, throttle: number}|null} input
     * @param {{gear: number, rpm: number}|null} drivetrain
     * @param {{offSurface?: string|null}|string|null} surface  Симът (чете се offSurface) или направо низът на настилката
     * @param {CarEffectsView|null} [view]
     */
    function update(dt, state, input, drivetrain, surface, view = null) {
        if (disposed) {
            return;
        }
        const speed = Math.abs(state?.vForward ?? 0);
        const brake = input?.brake ?? 0;
        const throttle = input?.throttle ?? 0;
        const replay = view?.replay === true;

        // Дисковете: предната ос поема ~65 % от спирането и грее първа.
        for (const axle of ['front', 'rear']) {
            let h = heat[axle];
            h += brake * speed * dt * HEAT_GAIN[axle];
            h -= (COOL_BASE + COOL_SPEED * speed) * h * dt;
            h = clamp(h, 0, 1);
            heat[axle] = h;

            const ring = ringMaterials[axle];
            heatToColor(h, heatColor);
            ring.color.copy(heatColor);
            ring.opacity = smoothstep(0.15, 0.6, h);
            const sprite = spriteMaterials[axle];
            sprite.color.copy(heatColor);
            sprite.opacity = smoothstep(0.45, 1, h) * 0.35;
            const glowing = ring.opacity > 0.01;
            for (const object of glowObjects[axle]) {
                object.visible = glowing && (object.isSprite ? sprite.opacity > 0.01 : true);
            }
        }

        // Ауспух: събитията идват от трансмисията (визуален слой).
        if (drivetrain) {
            const gear = drivetrain.gear;
            const rpmRatio = drivetrain.rpm / REDLINE;
            if (prevGear !== null && gear !== prevGear && speed > 2 && !replay) {
                if (
                    gear < prevGear &&
                    throttle < 0.15 &&
                    rpmRatio > 0.78 &&
                    random() < DOWNSHIFT_FLAME_CHANCE
                ) {
                    flashes.push(0, FLAME_DOWNSHIFT);
                }
            }
            prevGear = gear;
        }

        flash = 0;
        for (let i = flashes.length - 2; i >= 0; i -= 2) {
            if (flashes[i] > 0) {
                flashes[i] -= dt;
                continue;
            }
            flashes[i + 1] -= dt;
            if (flashes[i + 1] <= 0) {
                flashes.splice(i, 2);
                continue;
            }
            flash = 1;
        }

        flame.material.opacity = flash * 0.55;
        flame.visible = flash > 0;
        if (flash > 0) {
            // Пламъкът трепти: дължина/ширина и завъртане около оста си.
            flame.scale.set(0.7 + random() * 0.25, 1, 0.7 + random() * 0.25);
            flame.rotation.z = random() * Math.PI;
        }
        if (exhaustLight) {
            exhaustLight.intensity = flash * EXHAUST_LIGHT_INTENSITY;
        }

        // Blob: изсветлява, когато тялото се вдига (керб, heave).
        const lift = Math.min(1, Math.abs(rig.body.position.y) / 0.05);
        blob.material.opacity = (night ? BLOB_OPACITY_NIGHT : blobDay) * (1 - lift);

        // Прах: трупа се извън асфалта, чисти се на асфалт със скоростта.
        const off = typeof surface === 'string' ? surface : (surface?.offSurface ?? null);
        const gain = off && DIRT_GAIN[off] !== undefined ? DIRT_GAIN[off] : off ? DIRT_GAIN.gravel : DIRT_IDLE_GAIN;
        if (off && DIRT_COLORS[off]) {
            dirtColor.lerp(DIRT_COLORS[off], 1 - Math.exp(-2 * dt));
        }
        const clean = off ? 0 : DIRT_CLEAN * Math.min(1, speed / 20);
        const next = clamp(dirt + dt * (gain - clean), 0, 1);
        if (next !== dirt || off) {
            dirt = next;
            rig.setDirt(dirt, dirtColor);
        }

        // Heat haze: проекция на точката над ауспуха в екранни uv.
        const pass = gradePassOf();
        if (pass?.uniforms?.uHaze && camera) {
            const haze = pass.uniforms.uHaze.value;
            const chase = (view?.cameraMode ?? 'chase') === 'chase' && !replay;
            if (!chase) {
                haze.w = 0;
            } else {
                hazeWorld.copy(HAZE_LOCAL);
                rig.body.localToWorld(hazeWorld);
                hazeView.copy(hazeWorld).project(camera);
                const dist = camera.position.distanceTo(hazeWorld);
                const onScreen = hazeView.z < 1 && Math.abs(hazeView.x) < 1.3 && Math.abs(hazeView.y) < 1.3;
                const rpmRatio = drivetrain ? drivetrain.rpm / REDLINE : 0;
                const amp = onScreen && speed > 8
                    ? clamp(throttle * 0.6 + rpmRatio * 0.4, 0, 1) * 0.18
                    : 0;
                haze.set(hazeView.x * 0.5 + 0.5, hazeView.y * 0.5 + 0.5, 0.9 / Math.max(1, dist), amp);
            }
        }
    }

    return {
        update,

        /**
         * Проблясъци след дадени секунди — времената идват от аудиото
         * (sound.overrun), за да са пламъкът и звукът в синхрон.
         *
         * @param {number[]} times
         */
        pops(times) {
            if (!Array.isArray(times) || times.length === 0 || random() >= OVERRUN_FLAME_CHANCE) {
                return;
            }
            // Един от действителните аудио пукоти, а не огнена серия при всяко
            // отпускане. Така краткият визуален импулс остава синхронизиран.
            const index = Math.min(times.length - 1, Math.floor(random() * times.length));
            flashes.push(Math.max(0, times[index]), FLAME_POP);
        },

        /** @param {boolean} value */
        setNight(value) {
            night = value === true;
        },

        dirt() {
            return dirt;
        },

        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const object of owned) {
                object.parent?.remove(object);
            }
            ringGeometry.dispose();
            for (const material of [...Object.values(ringMaterials), ...Object.values(spriteMaterials)]) {
                material.dispose();
            }
            flame.geometry.dispose();
            flame.material.dispose();
            blob.geometry.dispose();
            blob.material.dispose();
            const pass = gradePassOf();
            if (pass?.uniforms?.uHaze) {
                pass.uniforms.uHaze.value.w = 0;
            }
            if (dirtUniforms) {
                dirtUniforms.uDirt.value = 0;
            }
        },
    };
}

// ── Материали и текстури ─────────────────────────────────────────────────

/**
 * HDR цветове (> 1 в линейно): в composer-а сцената е линейна до OutputPass
 * и bloom-ът (праг 1.0) хваща само нажежено-бялото. toneMapped остава true:
 * на телефона (директен рендер) tone mapping-ът ги компресира, вместо да
 * режат до бяло (виж wave 0).
 *
 * @returns {THREE.MeshBasicMaterial}
 */
function makeGlowMaterial() {
    const material = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
    });
    material.name = 'brake-glow';

    return material;
}

/** @type {THREE.CanvasTexture|null} */
let glowTexture = null;

/**
 * Радиален ореол за спрайта на главината (споделен, никой не го dispose-ва).
 *
 * @returns {THREE.Texture|null}
 */
function getGlowTexture() {
    if (glowTexture || typeof document === 'undefined') {
        return glowTexture;
    }
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    glowTexture = new THREE.CanvasTexture(canvas);
    glowTexture.name = 'hub-glow';

    return glowTexture;
}

/**
 * @returns {THREE.SpriteMaterial}
 */
function makeHubSpriteMaterial() {
    const material = new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: 0x000000,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
    });
    material.name = 'hub-glow';

    return material;
}

/**
 * Рампа на нажежено тяло: черно → тъмночервено → оранжево → бяло-горещо
 * (HDR над 0.8 — само то bloom-ва).
 *
 * @param {number} t 0..1
 * @param {THREE.Color} out
 */
function heatToColor(t, out) {
    if (t < 0.5) {
        const k = t / 0.5;
        out.setRGB(1.0 * k, 0.12 * k, 0.02 * k);
    } else if (t < 0.8) {
        const k = (t - 0.5) / 0.3;
        out.setRGB(1.0 + 1.6 * k, 0.12 + 0.78 * k, 0.02 + 0.18 * k);
    } else {
        const k = (t - 0.8) / 0.2;
        out.setRGB(2.6 + 1.4 * k, 0.9 + 1.5 * k, 0.2 + 0.8 * k);
    }
}

/** @type {THREE.CanvasTexture|null} */
let flameTexture = null;

/**
 * Пламък: вертикален градиент (ярък корен, гаснещ връх) × дребен шум, тесен
 * към върха. Споделен.
 *
 * @returns {THREE.Texture|null}
 */
function getFlameTexture() {
    if (flameTexture || typeof document === 'undefined') {
        return flameTexture;
    }
    const w = 32;
    const h = 96;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    const image = context.createImageData(w, h);
    const random = mulberry32(7);
    for (let y = 0; y < h; y++) {
        // v = 0 в корена (долу в canvas при flipY): яркостта гасне нагоре.
        const t = 1 - y / (h - 1);
        const width = 0.28 + 0.5 * (1 - t) ** 0.7;
        for (let x = 0; x < w; x++) {
            const u = (x + 0.5) / w - 0.5;
            const edge = Math.max(0, 1 - Math.abs(u) / (width / 2));
            const noise = 0.75 + 0.25 * random();
            const alpha = clamp(edge * edge * (1 - t) ** 0.6 * noise, 0, 1);
            const i = (y * w + x) * 4;
            image.data[i] = 255;
            image.data[i + 1] = Math.round(200 + 55 * t);
            image.data[i + 2] = Math.round(120 * t);
            image.data[i + 3] = Math.round(alpha * 255);
        }
    }
    context.putImageData(image, 0, 0);
    flameTexture = new THREE.CanvasTexture(canvas);
    flameTexture.name = 'exhaust-flame';

    return flameTexture;
}

/**
 * Две кръстосани равнини 0.10×0.32, коренът в ауспуха, опашката по −Z.
 * Един меш (слята геометрия) — един draw call.
 *
 * @returns {THREE.Mesh}
 */
function buildFlame() {
    const planes = [];
    for (const roll of [0, Math.PI / 2]) {
        const plane = new THREE.PlaneGeometry(0.1, 0.32);
        // +Y на равнината → −Z (назад); коренът (v = 0) в началото.
        plane.rotateX(-Math.PI / 2);
        plane.rotateZ(roll);
        plane.translate(0, 0, -0.16);
        planes.push(plane);
    }
    const geometry = mergePlanes(planes);
    const material = new THREE.MeshBasicMaterial({
        map: getFlameTexture(),
        color: new THREE.Color(1.8, 0.85, 0.24),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
    });
    material.name = 'exhaust-flame';
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'exhaust-flame';
    mesh.visible = false;
    mesh.frustumCulled = false;

    return mesh;
}

/**
 * Слива равнини с еднакви атрибути (position/normal/uv, индексирани) без
 * BufferGeometryUtils — две равнини не заслужават импорта.
 *
 * @param {THREE.PlaneGeometry[]} planes
 * @returns {THREE.BufferGeometry}
 */
function mergePlanes(planes) {
    const merged = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
        const arrays = planes.map((plane) => plane.getAttribute(name).array);
        const itemSize = planes[0].getAttribute(name).itemSize;
        const total = new Float32Array(arrays.reduce((sum, array) => sum + array.length, 0));
        let offset = 0;
        for (const array of arrays) {
            total.set(array, offset);
            offset += array.length;
        }
        merged.setAttribute(name, new THREE.BufferAttribute(total, itemSize));
    }
    const index = [];
    let base = 0;
    for (const plane of planes) {
        for (let i = 0; i < plane.index.count; i++) {
            index.push(plane.index.getX(i) + base);
        }
        base += plane.getAttribute('position').count;
        plane.dispose();
    }
    merged.setIndex(index);

    return merged;
}

/** @type {Map<string, THREE.CanvasTexture>} */
const blobTextures = new Map();

/**
 * Blob сянката като алфа карта (черно × алфа): елипса под цялото тяло +
 * четири по-плътни под гумите. Ключ по осите — съперниците с еднакъв GLB
 * делят една текстура. NormalBlending, не Multiply: three-йският Multiply е
 * (ZERO, SRC_COLOR) и игнорира opacity, а плътността трябва да се управлява
 * (ден/нощ, отлепяне при керб).
 *
 * @param {{front: {x: number, z: number}, rear: {x: number, z: number}}} axles
 * @returns {THREE.Texture|null}
 */
function getBlobTexture(axles) {
    if (typeof document === 'undefined') {
        return null;
    }
    const key = [axles.front.x, axles.front.z, axles.rear.x, axles.rear.z].map((v) => v.toFixed(2)).join('|');
    let texture = blobTextures.get(key);
    if (texture) {
        return texture;
    }
    const w = 128;
    const h = 256;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    // Равнината е 2.4 × 5.2 m, завъртяна така, че +Z (напред) е долу в
    // canvas-а (v = 0): px = (x/2.4 + 0.5)·w, py = (0.5 + z/5.2)·h.
    const px = (x) => (x / 2.4 + 0.5) * w;
    const py = (z) => (0.5 + z / 5.2) * h;

    const ellipse = (cx, cz, rx, rz, alpha) => {
        context.save();
        context.translate(px(cx), py(cz));
        context.scale((rx / 2.4) * w, (rz / 5.2) * h);
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
        gradient.addColorStop(0, `rgba(0,0,0,${alpha})`);
        gradient.addColorStop(0.6, `rgba(0,0,0,${alpha * 0.7})`);
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(0, 0, 1, 0, Math.PI * 2);
        context.fill();
        context.restore();
    };

    ellipse(0, -0.15, 0.95, 2.35, 0.55);
    for (const axle of ['front', 'rear']) {
        for (const side of [-1, 1]) {
            ellipse(side * axles[axle].x, axles[axle].z, 0.34, 0.42, 0.75);
        }
    }

    texture = new THREE.CanvasTexture(canvas);
    texture.name = 'car-blob';
    blobTextures.set(key, texture);

    return texture;
}

/**
 * Мъглата е включена нарочно: черен квадрат без мъгла под съперник на 300 m
 * би стоял като петно върху избледнелия асфалт; с мъгла потъмняването
 * гасне с разстоянието като всичко останало.
 *
 * @param {{front: {x: number, z: number}, rear: {x: number, z: number}}} axles
 * @param {number} opacity
 * @returns {THREE.Mesh}
 */
function buildBlobShadow(axles, opacity) {
    const geometry = new THREE.PlaneGeometry(2.4, 5.2);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
        map: getBlobTexture(axles),
        color: 0x000000,
        transparent: true,
        opacity,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    });
    material.name = 'car-blob';
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'car-blob';
    mesh.position.y = 0.012;
    mesh.renderOrder = 1;

    return mesh;
}

/**
 * Кръпка „прах" върху боята: маска по височина × шум по долната част на
 * тялото, цветът и грапавостта се смесват към прахта, лакът угасва там.
 * Влиза в metalnessmap_fragment, след завършения roughness pass и ливреята
 * в color_fragment, за да остане прахът над финиша на боята и карбона.
 *
 * @param {import('./car.js').CarRig} rig
 * @returns {{uDirt: {value: number}, uDirtColor: {value: THREE.Color}}|null}
 */
function installDirtPatch(rig) {
    if (!rig.paintMaterials?.length) {
        return null;
    }
    const uniforms = {
        uDirt: { value: 0 },
        uDirtColor: { value: new THREE.Color().copy(DIRT_COLORS.gravel) },
        tDirt: { value: getNoiseTexture(128) },
    };
    for (const material of rig.paintMaterials) {
        applyPatch(material, {
            name: 'dirt',
            uniforms,
            vertexHead: /* glsl */ `varying vec3 vDirtPos;`,
            vertexMain: /* glsl */ `vDirtPos = position;`,
            fragmentHead: /* glsl */ `
                varying vec3 vDirtPos;
                uniform float uDirt;
                uniform vec3 uDirtColor;
                uniform sampler2D tDirt;
                float carDirt = 0.0;`,
            replace: [
                [
                    'metalnessmap_fragment',
                    /* glsl */ `#include <metalnessmap_fragment>
                    {
                        float h = clamp(1.0 - vDirtPos.y / 0.55, 0.0, 1.0);
                        float n = texture2D(tDirt, vDirtPos.xz * 1.5).r;
                        carDirt = uDirt * smoothstep(0.35, 0.8, h * 0.7 + n * 0.5);
                        diffuseColor.rgb = mix(diffuseColor.rgb, uDirtColor, carDirt);
                        roughnessFactor = mix(roughnessFactor, 0.85, carDirt);
                    }`,
                ],
                [
                    'lights_physical_fragment',
                    /* glsl */ `#include <lights_physical_fragment>
                    #ifdef USE_CLEARCOAT
                        material.clearcoat *= 1.0 - carDirt * 0.8;
                    #endif`,
                ],
            ],
        });
    }
    rig.dirtUniforms = uniforms;

    return uniforms;
}

// ── Помощни ──────────────────────────────────────────────────────────────

/**
 * Детерминиран PRNG (mulberry32) за визуалното трептене — без Math.random,
 * за да е кадърът възпроизводим при QA снимки.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
    let a = seed >>> 0;

    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}

/**
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);

    return t * t * (3 - 2 * t);
}
