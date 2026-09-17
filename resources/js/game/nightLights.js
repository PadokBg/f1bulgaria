/**
 * Нощните писти (Бахрейн, Джеда, Сингапур, Вегас, Лосаил, Яс Марина):
 * светлината на прожекторните кули, вместо „плоска чернота с една directional".
 *
 *   - ореоли (glare) около всяка глава — инстанциран билборд, адитивен, HDR
 *     цвят: на десктоп bloom-ът го подпалва, на телефон (без composer) пак
 *     свети, защото е реална геометрия, а не пост ефект;
 *   - светлинни конуси (haze) от главата до асфалта — инстанциран обърнат
 *     конус с върхова алфа → основа 0; и двата пътя, 1 draw call;
 *   - басейни СВЕТЛИНА по асфалта: пул от истински SpotLight-ове (4 десктоп /
 *     2 телефон), които всеки кадър се преназначават към най-близките глави
 *     НАПРЕД по трасето. Броят им е фиксиран от старта: NUM_SPOT_LIGHTS влиза
 *     в ключа на всяка lit програма и добавяне/махане на светлина по време на
 *     игра би прекомпилирало всеки MeshStandardMaterial в сцената;
 *   - fill directional срещу главната (прожекторите светят отвсякъде — колата
 *     не бива да е наполовина черна), с главната свалена на 70 %;
 *   - светкавици от трибуните (Points, hash по време) — на десктоп bloom-ват,
 *     на телефон четат като бели точки;
 *   - лампи в питлейна пред гаражите и под тавана на тунела (Монако) — същите
 *     ореоли/конуси/пул, топъл цвят; кука за emissive върху фасадите.
 *
 * Модулът е ЧИСТО презентационен: чете позиция/индекс, не пише в симулацията.
 * Всичката „случайност" е seed-ната по slug (детерминирана картина).
 * Не пипа document/window — зарежда се и в Node (селфтестове).
 */

import * as THREE from 'three';

/** uDamp на surface-shader за нощния „sheen" на асфалта под прожекторите. */
export const NIGHT_SHEEN = 0.25;

/**
 * Параметри по подразбиране; circuit.look.nightLights (ако atmosphere ги
 * авторира някой ден) и options ги презаписват поле по поле.
 */
const DEFAULTS = Object.freeze({
    /** Височина на лампата над основата на пилона (decor.js: head.translate 14.1). */
    headHeight: 14.1,
    /**
     * Умерени прожектори: достатъчни за четим светлинен басейн върху асфалта,
     * без бял клип и без да надвиват общата нощна светлина.
     */
    spotIntensity: 440,
    spotDistance: 82,
    spotAngle: 0.55,
    spotPenumbra: 0.72,
    spotDecay: 1.5,
    spotColor: 0xf1f3f5,
    /** Секунди за плавно вдигане/сваляне на преназначен прожектор (без pop). */
    spotFade: 0.3,
    /** Колко метра ЗАД колата глава остава кандидат (басейнът ѝ е ±15 m). */
    behindMetres: 20,
    aheadMetres: 600,
    /** Сила на fill-а спрямо главната светлина и колко се сваля главната. */
    fillRatio: 0.36,
    sunScale: 0.7,
    fillColor: 0xe4e7e9,
    // Retain the authored circuit tint, with a neutral stadium-light core.
    // This keeps blue light from swallowing the red paint and dark carbon.
    keyTint: 0xf5f1e8,
    keyTintMix: 0.42,
    coneOpacity: 0.027,
    /** Визуалният конус е по-тесен от реалния spot: ярката сърцевина. */
    coneHalfAngle: 0.32,
    flashCount: 300,
    flashCountLowPower: 120,
    /** Пиксели (буферни) на светкавица при DPR 1 на 10 m. */
    flashSize: 26,
});

/** Външност на трите вида лампи (HDR цветове > 1 — bloom-ът ги вижда). */
const KINDS = Object.freeze({
    flood: { halo: 4.1, color: [1.48, 1.5, 1.52], penalty: 0, intensity: 1, distance: 1, angle: 1 },
    pit: { halo: 1.9, color: [1.7, 1.5, 1.18], penalty: 60, intensity: 0.25, distance: 0.45, angle: 1.35 },
    tunnel: { halo: 1.35, color: [1.8, 1.32, 0.82], penalty: 0, intensity: 0.12, distance: 0.22, angle: 1.55 },
});

// Копия на геометрията на decor.js/mesh.js за резервното разполагане (когато
// интеграторът не подаде данни за кулите/трибуните). Ако там се променят,
// ореолите ще се разминат с пилоните — затова подаването е предпочитано.
const TOWER_EVERY_METRES = 120;
const TOWER_OFFSET = 11;
const RUNOFF_DROP = 0.035;
const GRANDSTAND = { depth: 18, height: 12, section: 26, span: 165, gapMain: 7, bank: 0.6 };
const PIT = { laneOuter: 10.6, facade: 1.6, height: 8 };
const TUNNEL_HEIGHT = 4.6;

const HALO_VERTEX = /* glsl */ `
    attribute vec3 aDir;
    attribute vec3 aColor;
    attribute float aSize;
    varying vec2 vUv;
    varying float vAlpha;
    varying vec3 vColor;

    void main() {
        // Билборд: центърът минава през матриците, квадратът се лепи в view
        // пространството — винаги гледа камерата, независимо от посоката ѝ.
        vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec3 toCamera = normalize(-centre.xyz);
        vec3 beam = normalize((viewMatrix * vec4(aDir, 0.0)).xyz);
        // Заслепяване: когато лъчът сочи към камерата главата „гори", отзад
        // е само топла точка. Никога до нула — главата свети във всички посоки.
        float facing = dot(beam, toCamera);
        float glare = 0.35 + 0.65 * smoothstep(-0.3, 0.8, facing);
        // Леко нарастване с разстоянието: далечните глави да останат точки
        // светлина, а не да изчезнат под пиксел.
        float dist = length(centre.xyz);
        centre.xy += position.xy * aSize * (1.0 + dist * 0.0035);
        gl_Position = projectionMatrix * centre;
        vUv = uv;
        vAlpha = glare;
        vColor = aColor;
    }
`;

const HALO_FRAGMENT = /* glsl */ `
    uniform float uOpacity;
    varying vec2 vUv;
    varying float vAlpha;
    varying vec3 vColor;

    void main() {
        // Аналитичен радиален профил вместо canvas текстура: гореща сърцевина
        // + мек широк ореол; без document, без текстура за dispose.
        float d = length(vUv - vec2(0.5)) * 2.0;
        float soft = pow(max(0.0, 1.0 - d), 2.4);
        float core = exp(-d * d * 14.0);
        float a = (0.55 * soft + 0.45 * core) * vAlpha * uOpacity;
        gl_FragColor = vec4(vColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

const CONE_VERTEX = /* glsl */ `
    attribute vec3 aColor;
    varying float vFade;
    varying vec3 vColor;

    void main() {
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        // Нормалата през ротацията на инстанса (мащабът е неравномерен, но
        // алфата е мека — точната обратна транспонирана не си струва ALU-то).
        vec3 n = normalize(normalMatrix * (mat3(instanceMatrix) * normal));
        // Върхът (y = 0) ярък, основата (y = -1) прозрачна; квадратично —
        // мъглата се сгъстява до лампата.
        float along = clamp(-position.y, 0.0, 1.0);
        float fade = (1.0 - along) * (1.0 - along);
        // Дължина на пътя през обема: центърът на конуса е „дебел", силуетът
        // — тънък. Иначе кухият конус чете като два ръба.
        float view = abs(dot(n, normalize(-mvPosition.xyz)));
        fade *= 0.3 + 0.7 * view;
        // Гасне до камерата — минаването през конуса иначе е плоска стена.
        fade *= smoothstep(1.5, 10.0, -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
        vFade = fade;
        vColor = aColor;
    }
`;

const CONE_FRAGMENT = /* glsl */ `
    uniform float uOpacity;
    varying float vFade;
    varying vec3 vColor;

    void main() {
        gl_FragColor = vec4(vColor, vFade * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

const FLASH_VERTEX = /* glsl */ `
    attribute float aId;
    uniform float uTime;
    uniform float uPixelScale;
    uniform float uProjection;
    uniform float uSize;
    varying float vOn;

    void main() {
        // Осем слота в секунда; всяка точка има 1.5 % шанс на слот и свети
        // само първите 40 % от него (~50 ms) — къс блясък като реална
        // светкавица, не 125 ms лампа.
        float slot = floor(uTime * 8.0);
        float h = fract(sin(aId * 12.9898 + slot * 78.233) * 43758.5453);
        float on = step(0.985, h) * step(fract(uTime * 8.0), 0.4);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        // Буферни пиксели: uSize на 10 m при DPR 1 и FOV ~64°; uProjection =
        // 1/tan(fov/2) следва FOV анимацията (1.6 при 64°); uPixelScale =
        // DPR × renderScale (както частиците). Угасена точка е 1 px и се
        // discard-ва във фрагмента.
        float pixels = uSize * uPixelScale * (uProjection / 1.6) * 10.0 / max(1.0, -mvPosition.z);
        gl_PointSize = mix(1.0, pixels, on);
        gl_Position = projectionMatrix * mvPosition;
        vOn = on;
    }
`;

const FLASH_FRAGMENT = /* glsl */ `
    varying float vOn;

    void main() {
        if (vOn < 0.5) {
            discard;
        }
        float d = length(gl_PointCoord - vec2(0.5));
        float mask = smoothstep(0.5, 0.12, d);
        // HDR бяло: над прага на bloom-а на десктоп; на телефон tone
        // mapping-ът го свива до чисто бяла точка.
        gl_FragColor = vec4(vec3(2.8) * mask, mask);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

/**
 * @typedef {object} NightLightsOptions
 * @property {boolean} [lowPower]        Телефон: 2 прожектора, 120 светкавици
 * @property {object|null} [quality]     game.quality — приема се по общия
 *     договор на пакетите; тук нищо не зависи от него (lowPower решава всичко)
 * @property {{from: number, to: number, sign: number}|null} [pitRange]
 *     trackGroup.userData.pitRange — лампи пред гаражите + резервно
 *     разполагане на кулите/трибуните
 * @property {Array|null} [grandstands]  Обеми на трибуните за светкавиците:
 *     {x, y (земя), z, rotationY, depth, height, span, slope?} | THREE.Box3 |
 *     {min, max}. Липсва → стартовата трибуна + OSM контурите
 * @property {THREE.DirectionalLight|null} [sun]  Главната светлина: сваля се
 *     на sunScale и омекотява синия оттенък; двете се връщат при dispose
 * @property {THREE.Vector3|null} [sunDir]  Единичен вектор КЪМ слънцето (за
 *     огледалния fill); липсва → от sun.position
 * @property {number} [spotCount]        Пул прожектори (по подразбиране 4 / 2)
 * @property {number} [coneOpacity]
 * @property {number} [flashCount]
 * @property {number} [pixelScale]       DPR × renderScale за размера на светкавиците
 */

/**
 * @typedef {object} NightLights
 * @property {boolean} enabled              false = инертен обект (дневна писта без тунел)
 * @property {boolean} night
 * @property {(dt: number, carPosition: {x: number, z: number}|THREE.Vector3, camera: THREE.Camera, trackIndexHint?: number|null) => void} update
 * @property {() => void} dispose
 * @property {(materials: THREE.Material|THREE.Material[], options?: {intensity?: number, color?: number}) => number} registerEmissives
 * @property {(scale: number) => void} setPixelScale
 * @property {THREE.DirectionalLight|null} fillLight
 * @property {THREE.SpotLight[]} spotLights
 * @property {number} headCount
 */

/**
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @returns {boolean}
 */
export function isNightCircuit(circuit) {
    return circuit?.atmosphere?.night === true || circuit?.look?.preset === 'night';
}

/**
 * Нощен „sheen": по-гладък асфалт и пълна env карта, за да блестят басейните
 * на прожекторите; кербовете лъскави. Вика се СЛЕД зареждането на PBR
 * картите (roughness там е множител върху roughnessMap-а).
 *
 * @param {{asphalt?: THREE.MeshStandardMaterial, kerb?: THREE.MeshStandardMaterial}} surfaces
 */
export function applyNightSheen(surfaces) {
    if (surfaces?.asphalt) {
        surfaces.asphalt.roughness = Math.min(surfaces.asphalt.roughness, 0.6);
        surfaces.asphalt.envMapIntensity = 0.72;
    }
    if (surfaces?.kerb) {
        surfaces.kerb.roughness = Math.min(surfaces.kerb.roughness, 0.35);
    }
}

/**
 * Строи нощното осветление. Дневна писта без тунел → инертен обект (update и
 * dispose са празни), така че Game може да вика без проверка.
 *
 * ТРЯБВА да се извика ПРЕДИ #warmup: прожекторите и fill-ът влизат в броя
 * светлини на всяка lit програма.
 *
 * @param {THREE.Scene} scene
 * @param {import('./track.js').Track} track
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @param {THREE.Object3D|THREE.InstancedMesh|Array<THREE.Matrix4|{x: number, y: number, z: number, row?: number, headHeight?: number}>|null} towers
 *     Кулите от decor.js: групата на buildFloodlightTowers (главите се
 *     разпознават по emissive), InstancedMesh на главите/пилоните или списък
 *     с матрици/основи на пилоните (лъчът се насочва към осевата линия на
 *     най-близкия ред). Липсва → резервно разполагане по същото правило
 *     като decor.js (нужен е options.pitRange за пит/трибуна зоните)
 * @param {NightLightsOptions} [options]
 * @returns {NightLights}
 */
export function createNightLights(scene, track, circuit, towers, options = {}) {
    const night = isNightCircuit(circuit);
    const hasTunnel = Boolean(circuit?.tunnel);
    if (!night && !hasTunnel) {
        return inert();
    }

    const lowPower = options.lowPower === true;
    const look = circuit?.look?.nightLights ?? {};
    const cfg = { ...DEFAULTS, ...look };
    const coneOpacity = options.coneOpacity ?? look.coneOpacity ?? cfg.coneOpacity;

    const heads = [];
    if (night) {
        for (const head of floodlightHeads(track, circuit, towers, options.pitRange ?? null, cfg)) {
            heads.push(head);
        }
        if (options.pitRange && options.pitRange.from !== options.pitRange.to) {
            for (const head of pitHeads(track, options.pitRange, cfg)) {
                heads.push(head);
            }
        }
    }
    if (hasTunnel) {
        for (const head of tunnelHeads(track, circuit.tunnel, cfg)) {
            heads.push(head);
        }
    }

    const group = new THREE.Group();
    group.name = 'nightLights';
    group.matrixAutoUpdate = false;
    scene.add(group);

    // Телефон (без bloom): ореолът сам трябва да е сиянието — по-широк и
    // по-плътен; на десктоп bloom-ът го разлива и същото би било пресветено.
    const halos = buildHalos(heads, lowPower ? 1.15 : 0.9, lowPower ? 1 : 0.65);
    const cones = buildCones(heads, coneOpacity, cfg);
    group.add(halos.mesh, cones.mesh);

    // Тунел на дневна писта: пулът е само за галерията — 2 топли лампи над
    // колата вътре; на телефон нула (цената е върху ВСЕКИ осветен фрагмент
    // на цялата обиколка, а тунелът е 4 % от нея).
    const defaultSpots = night ? (lowPower ? 2 : 4) : lowPower ? 0 : 2;
    const spotCount = Math.max(0, Math.min(8, Math.round(options.spotCount ?? look.spotCount ?? defaultSpots)));
    const pool = createSpotPool(scene, spotCount, cfg);

    let flashes = null;
    let fill = null;
    const restoreSun = { light: null, intensity: 0, color: null };
    if (night) {
        const boxes = normalizeGrandstands(options.grandstands ?? null, track, circuit, options.pitRange ?? null);
        const flashCount = options.flashCount ?? look.flashCount ?? (lowPower ? cfg.flashCountLowPower : cfg.flashCount);
        if (boxes.length > 0 && flashCount > 0) {
            flashes = buildFlashes(boxes, flashCount, track.slug, options.pixelScale ?? 2, cfg);
            group.add(flashes.points);
        }

        // Fill срещу главната: огледална по хоризонталата, същата елевация.
        // Главната пада на 70 % → сборно ≈ 1.06× (басейните са отгоре).
        const sun = options.sun ?? null;
        const sunDir = options.sunDir ?? (sun ? sun.position.clone().sub(sun.target.position).normalize() : null);
        const baseIntensity = sun?.intensity ?? circuit.atmosphere?.sunIntensity ?? 2.3;
        fill = new THREE.DirectionalLight(cfg.fillColor, baseIntensity * cfg.fillRatio);
        fill.name = 'nightFill';
        fill.castShadow = false;
        if (sunDir) {
            fill.position.set(-sunDir.x, Math.max(0.35, sunDir.y), -sunDir.z).normalize().multiplyScalar(300);
        } else {
            fill.position.set(120, 200, -160);
        }
        fill.target.position.set(0, 0, 0);
        scene.add(fill, fill.target);
        if (sun) {
            restoreSun.light = sun;
            restoreSun.intensity = sun.intensity;
            restoreSun.color = sun.color.clone();
            sun.intensity = sun.intensity * cfg.sunScale;
            sun.color.lerp(new THREE.Color(cfg.keyTint), cfg.keyTintMix);
        }
    }

    const emissives = [];
    const progress = { row: 0, valid: false, window: Math.max(4, Math.ceil(80 / track.spacing)) };
    let time = 0;
    let disposed = false;

    /**
     * @param {number} dt
     * @param {{x: number, z: number}} carPosition
     * @param {THREE.Camera} camera
     * @param {number|null} [trackIndexHint] sim.trackIndexHint — спестява търсенето на реда
     */
    function update(dt, carPosition, camera, trackIndexHint = null) {
        if (disposed) {
            return;
        }
        time += dt;
        if (time > 4000) {
            time -= 4000; // fract(uTime*8) губи точност след часове attract демо
        }
        if (flashes) {
            flashes.material.uniforms.uTime.value = time;
            if (camera?.projectionMatrix) {
                flashes.material.uniforms.uProjection.value = camera.projectionMatrix.elements[5];
            }
        }
        if (pool.slots.length === 0 || heads.length === 0) {
            return;
        }
        const row = resolveRow(track, carPosition, trackIndexHint, progress);
        assignSpots(pool, heads, row, track, dt, cfg);
    }

    /**
     * Emissive за фасади/гаражи/бордове на нощна писта: картата на материала
     * става и emissiveMap (боксовете и прозорците светят), без да пишем
     * върху чужд модул. Само преди warmup (нова програма). Връща се при dispose.
     *
     * @param {THREE.Material|THREE.Material[]} materials
     * @param {{intensity?: number, color?: number}} [opts]
     * @returns {number} Колко материала са обработени
     */
    function registerEmissives(materials, opts = {}) {
        if (!night || disposed) {
            return 0;
        }
        const list = Array.isArray(materials) ? materials : [materials];
        let applied = 0;
        for (const material of list) {
            if (!material?.isMaterial || !material.emissive) {
                continue;
            }
            emissives.push({
                material,
                emissiveMap: material.emissiveMap,
                emissive: material.emissive.getHex(),
                intensity: material.emissiveIntensity,
            });
            if (material.map && !material.emissiveMap) {
                material.emissiveMap = material.map;
                material.needsUpdate = true;
            }
            material.emissive.set(opts.color ?? 0xffffff);
            material.emissiveIntensity = opts.intensity ?? 0.85;
            applied++;
        }
        return applied;
    }

    /** @param {number} scale DPR × renderScale (Game.#applyRenderScale) */
    function setPixelScale(scale) {
        if (flashes) {
            flashes.material.uniforms.uPixelScale.value = scale;
        }
    }

    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        scene.remove(group);
        halos.mesh.dispose();
        halos.mesh.geometry.dispose();
        halos.mesh.material.dispose();
        cones.mesh.dispose();
        cones.mesh.geometry.dispose();
        cones.mesh.material.dispose();
        if (flashes) {
            flashes.points.geometry.dispose();
            flashes.material.dispose();
        }
        for (const slot of pool.slots) {
            scene.remove(slot.light, slot.light.target);
            slot.light.dispose();
        }
        if (fill) {
            scene.remove(fill, fill.target);
            fill.dispose();
        }
        if (restoreSun.light) {
            restoreSun.light.intensity = restoreSun.intensity;
            restoreSun.light.color.copy(restoreSun.color);
        }
        for (const entry of emissives) {
            entry.material.emissiveMap = entry.emissiveMap;
            entry.material.emissive.setHex(entry.emissive);
            entry.material.emissiveIntensity = entry.intensity;
            entry.material.needsUpdate = true;
        }
        emissives.length = 0;
    }

    return {
        enabled: true,
        night,
        update,
        dispose,
        registerEmissives,
        setPixelScale,
        fillLight: fill,
        spotLights: pool.slots.map((slot) => slot.light),
        headCount: heads.length,
    };
}

/** @returns {NightLights} */
function inert() {
    return {
        enabled: false,
        night: false,
        update() {},
        dispose() {},
        registerEmissives() {
            return 0;
        },
        setPixelScale() {},
        fillLight: null,
        spotLights: [],
        headCount: 0,
    };
}

// ── Глави (лампи) ──────────────────────────────────────────────────────────

/**
 * @typedef {object} Head
 * @property {'flood'|'pit'|'tunnel'} kind
 * @property {THREE.Vector3} position  Лампата
 * @property {THREE.Vector3} target    Точката на асфалта, към която свети
 * @property {THREE.Vector3} dir       Единичен вектор лампа → цел
 * @property {number} row              Ред по трасето (за подбора „напред")
 * @property {THREE.Color} color       Цвят на прожектора
 * @property {number} intensity        Кандели
 * @property {number} distance
 * @property {number} angle
 * @property {number} penalty          Метри „наказание" при подбора (питът губи от кулите)
 */

/**
 * @param {import('./track.js').Track} track
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @param {*} towers
 * @param {{from: number, to: number, sign: number}|null} pitRange
 * @param {typeof DEFAULTS} cfg
 * @returns {Head[]}
 */
function floodlightHeads(track, circuit, towers, pitRange, cfg) {
    let bases = readTowerBases(towers, cfg.headHeight);
    if (bases.length === 0) {
        bases = placeTowers(track, circuit, pitRange, cfg.headHeight);
    }

    const heads = [];
    for (const base of bases) {
        const row = base.row ?? nearestRow(track, base.x, base.z);
        const position = new THREE.Vector3(base.x, base.y + base.headHeight, base.z);
        // Целта: осевата линия на реда — басейнът ляга върху трасето.
        const target = new THREE.Vector3(track.xs[row], track.ys[row], track.zs[row]);
        heads.push(makeHead('flood', position, target, row, cfg));
    }
    return heads;
}

/**
 * Лампи пред фасадата на гаражите (decor.js buildPitComplex: laneOuter =
 * maxHalf + 10.6, фасада на +1.6, височина 8), на всеки 12 m, светят надолу
 * към лентата.
 *
 * @param {import('./track.js').Track} track
 * @param {{from: number, to: number, sign: number}} pit
 * @param {typeof DEFAULTS} cfg
 * @returns {Head[]}
 */
function pitHeads(track, pit, cfg) {
    const { count, spacing } = track;
    const span = pit.to - pit.from;
    if (span * spacing < 40) {
        return [];
    }
    let half = 0;
    for (let r = pit.from; r <= pit.to; r++) {
        half = Math.max(half, track.halfWidths[wrapRow(r, count)]);
    }
    const taper = Math.min(14, Math.floor(span * 0.2));
    const mid = Math.floor((pit.from + pit.to) / 2);
    const garFrom = Math.max(pit.from + taper + 3, mid - 32);
    const garTo = Math.min(pit.to - taper - 3, mid + 32);
    if (garTo - garFrom <= 10) {
        return [];
    }
    const laneOuter = half + PIT.laneOuter;
    const lampOffset = pit.sign * (laneOuter + PIT.facade - 0.4);
    const targetOffset = pit.sign * (laneOuter - 3.2);
    const every = Math.max(1, Math.round(12 / spacing));

    const heads = [];
    for (let r = garFrom + 1; r < garTo; r += every) {
        const i = wrapRow(r, count);
        const drop = (Math.abs(lampOffset) - track.halfWidths[i]) * RUNOFF_DROP;
        const position = new THREE.Vector3(
            track.xs[i] + track.nx[i] * lampOffset,
            track.ys[i] - drop + PIT.height - 0.6,
            track.zs[i] + track.nz[i] * lampOffset
        );
        const target = new THREE.Vector3(
            track.xs[i] + track.nx[i] * targetOffset,
            track.ys[i] - drop,
            track.zs[i] + track.nz[i] * targetOffset
        );
        heads.push(makeHead('pit', position, target, i, cfg));
    }
    return heads;
}

/**
 * Лампи под тавана на тунела (decor.js buildTunnel: височина 4.6), на 10 m.
 *
 * @param {import('./track.js').Track} track
 * @param {{from: number, to: number}} tunnel Метри по обиколката
 * @param {typeof DEFAULTS} cfg
 * @returns {Head[]}
 */
function tunnelHeads(track, tunnel, cfg) {
    const { count, spacing } = track;
    const rowFrom = Math.round(tunnel.from / spacing);
    const rowTo = Math.round(tunnel.to / spacing);
    const every = Math.max(1, Math.round(10 / spacing));
    const heads = [];
    for (let r = rowFrom + every; r < rowTo - 1; r += every) {
        const i = wrapRow(r, count);
        const position = new THREE.Vector3(track.xs[i], track.ys[i] + TUNNEL_HEIGHT - 0.25, track.zs[i]);
        const target = new THREE.Vector3(track.xs[i], track.ys[i], track.zs[i]);
        heads.push(makeHead('tunnel', position, target, i, cfg));
    }
    return heads;
}

/**
 * @param {'flood'|'pit'|'tunnel'} kind
 * @param {THREE.Vector3} position
 * @param {THREE.Vector3} target
 * @param {number} row
 * @param {typeof DEFAULTS} cfg
 * @returns {Head}
 */
function makeHead(kind, position, target, row, cfg) {
    const spec = KINDS[kind];
    const color = kind === 'flood' ? new THREE.Color(cfg.spotColor) : new THREE.Color(spec.color[0], spec.color[1], spec.color[2]).multiplyScalar(0.36);
    return {
        kind,
        position,
        target,
        dir: target.clone().sub(position).normalize(),
        row,
        color,
        intensity: cfg.spotIntensity * spec.intensity,
        distance: cfg.spotDistance * spec.distance,
        angle: Math.min(Math.PI / 2, cfg.spotAngle * spec.angle),
        penalty: spec.penalty,
    };
}

/**
 * Основите на пилоните от каквото decor подаде: група (главите по emissive,
 * иначе най-високата инстанцирана геометрия), InstancedMesh, списък от
 * Matrix4 / {matrix} / {x, y, z, dirX?, dirZ?, row?, headHeight?}.
 *
 * @param {*} towers
 * @param {number} headHeight
 * @returns {Array<{x: number, y: number, z: number, headHeight: number, row: number|null}>}
 */
function readTowerBases(towers, headHeight) {
    if (!towers) {
        return [];
    }
    if (towers.isInstancedMesh) {
        return basesFromInstanced(towers, headHeight);
    }
    if (towers.isObject3D) {
        let heads = null;
        let tallest = null;
        towers.traverse((object) => {
            if (!object.isInstancedMesh) {
                return;
            }
            const material = Array.isArray(object.material) ? object.material[0] : object.material;
            if ((material?.emissiveIntensity ?? 0) > 1 && !heads) {
                heads = object;
            }
            if (!tallest || topOf(object.geometry) > topOf(tallest.geometry)) {
                tallest = object;
            }
        });
        const mesh = heads ?? tallest;
        return mesh ? basesFromInstanced(mesh, headHeight) : [];
    }
    if (!Array.isArray(towers)) {
        return [];
    }
    const out = [];
    const position = new THREE.Vector3();
    for (const entry of towers) {
        const matrix = entry?.isMatrix4 ? entry : entry?.matrix?.isMatrix4 ? entry.matrix : null;
        if (matrix) {
            position.setFromMatrixPosition(matrix);
            out.push({ x: position.x, y: position.y, z: position.z, headHeight, row: null });
        } else if (entry && Number.isFinite(entry.x) && Number.isFinite(entry.z)) {
            out.push({
                x: entry.x,
                y: entry.y ?? 0,
                z: entry.z,
                headHeight: entry.headHeight ?? headHeight,
                row: Number.isInteger(entry.row) ? entry.row : Number.isInteger(entry.index) ? entry.index : null,
            });
        }
    }
    return out;
}

/**
 * @param {THREE.InstancedMesh} mesh
 * @param {number} headHeight
 * @returns {Array<{x: number, y: number, z: number, headHeight: number, row: number|null}>}
 */
function basesFromInstanced(mesh, headHeight) {
    // Главите са кутия около 14.1 (центърът), пилонът стига до 14 (върхът):
    // и в двата случая лампата е под горния ръб на геометрията.
    const top = topOf(mesh.geometry);
    const lampHeight = Number.isFinite(top) && top > 1 ? top - 0.25 : headHeight;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const out = [];
    for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix);
        out.push({ x: position.x, y: position.y, z: position.z, headHeight: lampHeight, row: null });
    }
    return out;
}

/**
 * @param {THREE.BufferGeometry} geometry
 * @returns {number}
 */
function topOf(geometry) {
    if (!geometry) {
        return -Infinity;
    }
    if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
    }
    return geometry.boundingBox.max.y;
}

/**
 * Резервно разполагане на кулите — същото правило като decor.js
 * buildFloodlightTowers (на 120 m, редуващи се страни, пропуска пит зоната
 * и стартовата трибуна). Само когато интеграторът не подаде кулите.
 *
 * @param {import('./track.js').Track} track
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @param {{from: number, to: number, sign: number}|null} pit
 * @param {number} headHeight
 * @returns {Array<{x: number, y: number, z: number, headHeight: number, row: number}>}
 */
function placeTowers(track, circuit, pit, headHeight) {
    const { count, spacing } = track;
    const every = Math.max(1, Math.round(TOWER_EVERY_METRES / spacing));
    const hasGrandstands = circuit?.startGrandstands === true;
    const wrapped = (i) => (i > count / 2 ? i - count : i);
    const inPit = (i) => pit !== null && wrapped(i) > pit.from && wrapped(i) < pit.to;
    const inGrandstand = (i) => {
        const metres = wrapped(i) * spacing;
        return metres > -20 && metres < 150;
    };
    const blocked = (i, side) =>
        (pit !== null && inPit(i) && side === pit.sign) ||
        (hasGrandstands && pit !== null && side === -pit.sign && inGrandstand(i));

    const out = [];
    let slot = 0;
    for (let i = 0; i < count; i += every) {
        let side = slot % 2 === 0 ? 1 : -1;
        slot++;
        if (blocked(i, side)) {
            side = -side;
            if (blocked(i, side)) {
                continue;
            }
        }
        const offset = side * (track.halfWidths[i] + TOWER_OFFSET);
        out.push({
            x: track.xs[i] + track.nx[i] * offset,
            y: track.ys[i] - Math.abs(offset) * RUNOFF_DROP - offset * track.bankSlope[i],
            z: track.zs[i] + track.nz[i] * offset,
            headHeight,
            row: i,
        });
    }
    return out;
}

// ── Ореоли и конуси ────────────────────────────────────────────────────────

/**
 * @param {Head[]} heads
 * @param {number} sizeScale
 * @param {number} opacity
 * @returns {{mesh: THREE.InstancedMesh}}
 */
function buildHalos(heads, sizeScale, opacity) {
    const count = Math.max(1, heads.length);
    const geometry = new THREE.PlaneGeometry(1, 1);
    const dirs = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const material = new THREE.ShaderMaterial({
        vertexShader: HALO_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        uniforms: { uOpacity: { value: opacity } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = 'floodlightHalos';
    mesh.matrixAutoUpdate = false;

    const matrix = new THREE.Matrix4();
    let maxSize = 1;
    for (let i = 0; i < heads.length; i++) {
        const head = heads[i];
        const spec = KINDS[head.kind];
        matrix.makeTranslation(head.position.x, head.position.y, head.position.z);
        mesh.setMatrixAt(i, matrix);
        dirs[i * 3] = head.dir.x;
        dirs[i * 3 + 1] = head.dir.y;
        dirs[i * 3 + 2] = head.dir.z;
        colors[i * 3] = spec.color[0];
        colors[i * 3 + 1] = spec.color[1];
        colors[i * 3 + 2] = spec.color[2];
        sizes[i] = spec.halo * sizeScale;
        maxSize = Math.max(maxSize, sizes[i]);
    }
    mesh.count = heads.length;
    geometry.setAttribute('aDir', new THREE.InstancedBufferAttribute(dirs, 3));
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 1));
    // Квадратът расте в шейдъра (размер × до ~3 на далечина) — сферата на
    // геометрията трябва да го побере, иначе frustum тестът реже ръба.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), maxSize * 3);
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    mesh.renderOrder = 2;
    return { mesh };
}

/**
 * @param {Head[]} heads
 * @param {number} opacity
 * @param {typeof DEFAULTS} cfg
 * @returns {{mesh: THREE.InstancedMesh}}
 */
function buildCones(heads, opacity, cfg) {
    const count = Math.max(1, heads.length);
    // Единичен отворен конус с връх в началото и ос -Y; мащабът на инстанса
    // го разтяга до дължина лампа→цел и радиус по coneHalfAngle.
    const geometry = new THREE.ConeGeometry(1, 1, 12, 1, true);
    geometry.translate(0, -0.5, 0);
    const colors = new Float32Array(count * 3);
    const material = new THREE.ShaderMaterial({
        vertexShader: CONE_VERTEX,
        fragmentShader: CONE_FRAGMENT,
        uniforms: { uOpacity: { value: opacity } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = 'floodlightCones';
    mesh.matrixAutoUpdate = false;

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    const tan = Math.tan(cfg.coneHalfAngle);
    for (let i = 0; i < heads.length; i++) {
        const head = heads[i];
        const spec = KINDS[head.kind];
        const length = head.position.distanceTo(head.target);
        quaternion.setFromUnitVectors(down, head.dir);
        scale.set(length * tan, length, length * tan);
        matrix.compose(head.position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
        colors[i * 3] = spec.color[0];
        colors[i * 3 + 1] = spec.color[1];
        colors[i * 3 + 2] = spec.color[2];
    }
    mesh.count = heads.length;
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    mesh.renderOrder = 1;
    return { mesh };
}

// ── Прожекторен пул ────────────────────────────────────────────────────────

/**
 * @typedef {object} SpotSlot
 * @property {THREE.SpotLight} light
 * @property {Head|null} head
 * @property {number} fade   0..1, дял от пълната сила
 * @property {boolean} wanted
 */

/**
 * @param {THREE.Scene} scene
 * @param {number} count
 * @param {typeof DEFAULTS} cfg
 * @returns {{slots: SpotSlot[], desired: Array<Head|null>, scores: Float64Array}}
 */
function createSpotPool(scene, count, cfg) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        const light = new THREE.SpotLight(cfg.spotColor, 0, cfg.spotDistance, cfg.spotAngle, cfg.spotPenumbra, cfg.spotDecay);
        light.name = `floodlight${i}`;
        light.castShadow = false;
        // Далеч под трасето, докато не получи глава — светлина с intensity 0
        // и без цел пак минава през шейдъра, но не свети.
        light.position.set(0, -1000, 0);
        light.target.position.set(0, -1010, 0);
        scene.add(light, light.target);
        slots.push({ light, head: null, fade: 0, wanted: false });
    }
    return { slots, desired: new Array(count).fill(null), scores: new Float64Array(count) };
}

/**
 * Подбор на най-близките `count` глави НАПРЕД по трасето (до behindMetres
 * назад) и преназначаване на прожекторите с плавно вдигане/сваляне.
 *
 * @param {{slots: SpotSlot[], desired: Array<Head|null>, scores: Float64Array}} pool
 * @param {Head[]} heads
 * @param {number} row  Редът на колата
 * @param {import('./track.js').Track} track
 * @param {number} dt
 * @param {typeof DEFAULTS} cfg
 */
function assignSpots(pool, heads, row, track, dt, cfg) {
    const { slots, desired, scores } = pool;
    const { count, spacing } = track;
    const size = slots.length;

    // Частично сортиране: size е 2-4, heads ~50-90 → вмъкване в малък масив.
    let filled = 0;
    for (const head of heads) {
        let ahead = head.row - row;
        if (ahead > count / 2) {
            ahead -= count;
        } else if (ahead < -count / 2) {
            ahead += count;
        }
        const metres = ahead * spacing;
        if (metres < -cfg.behindMetres || metres > cfg.aheadMetres) {
            continue;
        }
        const score = metres + head.penalty;
        if (filled === size && score >= scores[filled - 1]) {
            continue;
        }
        let at = filled < size ? filled : size - 1;
        while (at > 0 && scores[at - 1] > score) {
            desired[at] = desired[at - 1];
            scores[at] = scores[at - 1];
            at--;
        }
        desired[at] = head;
        scores[at] = score;
        if (filled < size) {
            filled++;
        }
    }
    for (let i = filled; i < size; i++) {
        desired[i] = null;
    }

    for (const slot of slots) {
        slot.wanted = slot.head !== null && desired.includes(slot.head);
    }
    const fadeStep = dt / cfg.spotFade;
    for (let i = 0; i < filled; i++) {
        const head = desired[i];
        if (slots.some((slot) => slot.head === head)) {
            continue;
        }
        // Свободен слот, иначе най-угасналият от ненужните — но само ако вече
        // е почти угаснал: кражба на още светещ прожектор е pop до нула.
        // Ненужният догаря за 0.3 s и новата глава (стотици метри напред)
        // може да изчака толкова.
        let victim = null;
        for (const slot of slots) {
            if (slot.wanted) {
                continue;
            }
            if (slot.head === null) {
                victim = slot;
                break;
            }
            if (slot.fade < 0.15 && (victim === null || slot.fade < victim.fade)) {
                victim = slot;
            }
        }
        if (victim === null) {
            continue;
        }
        aimSlot(victim, head);
        victim.wanted = true;
    }

    for (const slot of slots) {
        if (slot.head === null) {
            continue;
        }
        if (slot.wanted) {
            slot.fade = Math.min(1, slot.fade + fadeStep);
        } else {
            slot.fade = Math.max(0, slot.fade - fadeStep);
            if (slot.fade === 0) {
                slot.head = null;
                slot.light.intensity = 0;
                continue;
            }
        }
        const eased = slot.fade * slot.fade * (3 - 2 * slot.fade);
        slot.light.intensity = slot.head.intensity * eased;
    }
}

/**
 * @param {SpotSlot} slot
 * @param {Head} head
 */
function aimSlot(slot, head) {
    const light = slot.light;
    light.position.copy(head.position);
    light.target.position.copy(head.target);
    light.color.copy(head.color);
    light.distance = head.distance;
    light.angle = head.angle;
    light.intensity = 0;
    slot.head = head;
    slot.fade = 0;
}

// ── Светкавици ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} StandBox
 * @property {number} cx @property {number} cy Земята @property {number} cz
 * @property {number} rotY   Локалният +X сочи към трасето
 * @property {number} depth @property {number} height @property {number} span
 * @property {number} slope  Дял, с който предният ръб на банката е свален (0 = плосък покрив)
 */

/**
 * @param {Array|null} input
 * @param {import('./track.js').Track} track
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @param {{from: number, to: number, sign: number}|null} pitRange
 * @returns {StandBox[]}
 */
function normalizeGrandstands(input, track, circuit, pitRange) {
    const boxes = [];
    if (Array.isArray(input)) {
        for (const entry of input) {
            const box = toStandBox(entry);
            if (box) {
                boxes.push(box);
            }
        }
        return boxes;
    }

    // Резерв: стартовата трибуна (mesh.js grandstandPlacements) + OSM контурите.
    if (circuit?.startGrandstands === true && pitRange && !circuit.streetWalls) {
        const { count, spacing } = track;
        const step = Math.max(1, Math.round(GRANDSTAND.section / spacing));
        const sections = Math.max(3, Math.round(GRANDSTAND.span / GRANDSTAND.section));
        const sign = -pitRange.sign;
        const startRow = -Math.round(20 / spacing);
        for (let s = 0; s < sections; s++) {
            const i = wrapRow(startRow + s * step, count);
            const off = sign * (track.halfWidths[i] + GRANDSTAND.gapMain + GRANDSTAND.depth / 2);
            boxes.push({
                cx: track.xs[i] + track.nx[i] * off,
                cy: track.ys[i] - (Math.abs(off) - track.halfWidths[i]) * RUNOFF_DROP - 0.3,
                cz: track.zs[i] + track.nz[i] * off,
                rotY: Math.atan2(track.tx[i], track.tz[i]) + (sign < 0 ? Math.PI : 0),
                depth: GRANDSTAND.depth,
                height: GRANDSTAND.height,
                span: GRANDSTAND.section * 0.9,
                slope: GRANDSTAND.bank,
            });
        }
    }
    for (const ring of track.landmarks?.grandstands ?? []) {
        if (!Array.isArray(ring) || ring.length < 3) {
            continue;
        }
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const [x, z] of ring) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z);
            maxZ = Math.max(maxZ, z);
        }
        const cx = (minX + maxX) / 2;
        const cz = (minZ + maxZ) / 2;
        const row = nearestRow(track, cx, cz);
        boxes.push({
            cx,
            cy: track.ys[row],
            cz,
            rotY: 0,
            depth: maxX - minX,
            height: 11,
            span: maxZ - minZ,
            slope: 0,
        });
    }
    return boxes;
}

/**
 * @param {*} entry
 * @returns {StandBox|null}
 */
function toStandBox(entry) {
    if (!entry) {
        return null;
    }
    const aabb = entry.isBox3 ? entry : entry.min && entry.max ? entry : null;
    if (aabb) {
        const min = aabb.min;
        const max = aabb.max;
        return {
            cx: (min.x + max.x) / 2,
            cy: min.y,
            cz: (min.z + max.z) / 2,
            rotY: 0,
            depth: max.x - min.x,
            height: max.y - min.y,
            span: max.z - min.z,
            slope: 0,
        };
    }
    if (Number.isFinite(entry.x) && Number.isFinite(entry.z) && Number.isFinite(entry.depth)) {
        return {
            cx: entry.x,
            cy: entry.y ?? 0,
            cz: entry.z,
            rotY: entry.rotationY ?? entry.rotY ?? 0,
            depth: entry.depth,
            height: entry.height ?? GRANDSTAND.height,
            span: entry.span ?? GRANDSTAND.section,
            slope: entry.slope ?? 0,
        };
    }
    return null;
}

/**
 * Points над седалките: точките лежат на 0.5 m над наклонената банка (или
 * плоския покрив на общ обем), за да не потъват в бетона и да не ги реже
 * покривът. Разпределени по площ на секциите; seed по slug.
 *
 * @param {StandBox[]} boxes
 * @param {number} total
 * @param {string} slug
 * @param {number} pixelScale
 * @param {typeof DEFAULTS} cfg
 * @returns {{points: THREE.Points, material: THREE.ShaderMaterial}}
 */
function buildFlashes(boxes, total, slug, pixelScale, cfg) {
    const rand = mulberry32(hashString(`night-flashes:${slug}`));
    const positions = new Float32Array(total * 3);
    const ids = new Float32Array(total);
    let area = 0;
    for (const box of boxes) {
        area += box.depth * box.span;
    }
    let n = 0;
    for (let b = 0; b < boxes.length && n < total; b++) {
        const box = boxes[b];
        const share = b === boxes.length - 1 ? total - n : Math.round((total * box.depth * box.span) / area);
        const sin = Math.sin(box.rotY);
        const cos = Math.cos(box.rotY);
        for (let k = 0; k < share && n < total; k++) {
            // front: 1 откъм трасето (локален +X), 0 отзад; краищата се
            // пропускат — при 0 банката опира в покрива, при 1 е ръбът.
            const front = 0.12 + rand() * 0.8;
            const lx = (front - 0.5) * box.depth;
            const lz = (rand() - 0.5) * box.span * 0.94;
            const y = box.cy + box.height * (1 - box.slope * front) + 0.5;
            positions[n * 3] = box.cx + lx * cos + lz * sin;
            positions[n * 3 + 1] = y;
            positions[n * 3 + 2] = box.cz - lx * sin + lz * cos;
            ids[n] = n + 1;
            n++;
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aId', new THREE.BufferAttribute(ids, 1));
    geometry.setDrawRange(0, n);
    geometry.computeBoundingSphere();
    const material = new THREE.ShaderMaterial({
        vertexShader: FLASH_VERTEX,
        fragmentShader: FLASH_FRAGMENT,
        uniforms: {
            uTime: { value: 0 },
            uPixelScale: { value: pixelScale },
            uProjection: { value: 1.6 },
            uSize: { value: cfg.flashSize },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
    });
    const points = new THREE.Points(geometry, material);
    points.name = 'crowdFlashes';
    points.matrixAutoUpdate = false;
    points.frustumCulled = true;
    points.renderOrder = 2;
    return { points, material };
}

// ── Помощни ────────────────────────────────────────────────────────────────

/**
 * Редът на колата: hint от симулацията, иначе локално търсене около
 * последния (пълно сканиране само при скок — ресет/реплей).
 *
 * @param {import('./track.js').Track} track
 * @param {{x: number, z: number}} position
 * @param {number|null} hint
 * @param {{row: number, valid: boolean, window: number}} progress
 * @returns {number}
 */
function resolveRow(track, position, hint, progress) {
    if (Number.isInteger(hint)) {
        progress.row = wrapRow(hint, track.count);
        progress.valid = true;
        return progress.row;
    }
    const x = position?.x ?? 0;
    const z = position?.z ?? 0;
    if (progress.valid) {
        const { count } = track;
        let best = progress.row;
        let bestDist = Infinity;
        for (let d = -progress.window; d <= progress.window; d++) {
            const i = wrapRow(progress.row + d, count);
            const dx = track.xs[i] - x;
            const dz = track.zs[i] - z;
            const dist = dx * dx + dz * dz;
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        if (bestDist < 40 * 40) {
            progress.row = best;
            return best;
        }
    }
    progress.row = nearestRow(track, x, z);
    progress.valid = true;
    return progress.row;
}

/**
 * @param {import('./track.js').Track} track
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
function nearestRow(track, x, z) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < track.count; i++) {
        const dx = track.xs[i] - x;
        const dz = track.zs[i] - z;
        const dist = dx * dx + dz * dz;
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    }
    return best;
}

/**
 * @param {number} row
 * @param {number} count
 * @returns {number}
 */
function wrapRow(row, count) {
    return ((row % count) + count) % count;
}

/**
 * Детерминиран PRNG (mulberry32) — копие на този в Game.js/noiseTex.js, за да
 * няма зависимост към оркестратора.
 *
 * @param {number} seed
 * @returns {() => number} [0, 1)
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
 * FNV-1a хеш на низ → seed.
 *
 * @param {string} value
 * @returns {number}
 */
function hashString(value) {
    let hash = 2166136261;

    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}
