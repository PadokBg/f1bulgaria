/**
 * Един композируем повърхностен шейдър за настилките на пистата: асфалт,
 * run-off асфалт, трева/банкет, чакъл, терен и кербове.
 *
 * ЗАЩО един модул: пет отделни предложения искаха да подменят едни и същи
 * chunk-ове (map_fragment, roughnessmap_fragment, normal_fragment_maps,
 * lights_fragment_begin) — всяко за свой ефект. Тук всички повърхностни
 * ефекти живеят в ЕДНА именувана кръпка („surface") върху materialPatch.js,
 * с флагове по вид настилка и по устройство; никой друг пакет не пипа тези
 * chunk-ове. Мъглата (fog_*) е на atmosphere.js — тук не се докосва, и
 * кръпката компилира със или без нейния override (chunk-овете не се
 * пресичат).
 *
 * Модулът НЕ създава материали — получава ги (mesh.js / terrain.js) и ги
 * кърпи. Същите обекти остават и след като Game.js им сложи PBR картите
 * (само map/normalMap/roughnessMap се сменят → three прекомпилира с
 * USE_MAP и кръпката влиза отново).
 *
 * Данни за реда (къде е състезателната линия, колко е остър завоят, има ли
 * спиране, равно ли е): споделеният договор на геометрията дава само
 * aLateral / aAlong / aHalfWidth. Всичко останало се пече ВЕДНЪЖ в 1-D
 * „профилна" текстура (count × 1 RGBA8), индексирана по aAlong — един евтин
 * texture fetch вместо пет допълнителни атрибута, и геометрията не зависи
 * от този модул. R: отместване на линията (±10 m), G: мрамори (|кривина|
 * на линията), B: спирачна зона, A: равнинност (за локвите).
 *
 * Матрица на ефектите (D = десктоп, M = lowPower):
 *
 *   вид       антитайл  макро  гума/износване  линии  кръпки  detail-N  облаци  мокро     банкет
 *   asphalt   D         DM     DM (мрамори D)  DM     D       D         DM      DM (локви D)
 *   runoff    D         DM     -               -      -       D         DM      DM (локви D)
 *   grass     D         DM     -               -      -       -         DM      леко         DM
 *   gravel    D         DM     -               -      -       -         DM      леко
 *   terrain   D (world) DM     -               -      -       -         DM      леко      + distance fade
 *   kerb      -         -      -               -      -       -         DM      блясък
 *
 * Мобилен път (lowPower): асфалтът добавя 1 шумов + 1 профилен fetch (и 1
 * облачен, ако пистата има облаци) към единствения diffuse tap — това е
 * гумираната линия, макро тонът и линиите, без хеширани тайлове. Теренът
 * там е MeshLambertMaterial (terrain.js) — без roughness изобщо, така че
 * кръпката пропуска `roughnessmap_fragment` за него: Lambert няма този
 * chunk и materialPatch би гръмнал при компилация (счупен кадър на всеки
 * телефон, болидът не се рисува). Решава се по класа на материала при
 * кърпенето, не по lowPower — същият материал може да дойде и от другаде.
 *
 * Анти-тайлинг: техниката на Quilez (два виртуални тайла с хеширани
 * отмествания, смесени по нискочестотен шум) с textureGrad, за да не
 * гърмят mip производните на границите. Умишлено НЕ е вариантът с
 * `floor(uv)` клетки — там отместването скача на всяка граница на тайла и
 * шевът се вижда. Същите отмествания и тегло се ползват за map, normalMap
 * и roughnessMap, така че релефът съвпада с албедото.
 *
 * Тестова бележка: заменените chunk-ове са `map_fragment`,
 * `roughnessmap_fragment` (само Standard/Physical), `normal_fragment_maps`,
 * `lights_fragment_begin` (последният се запазва като include и само се
 * допълва) — имената са проверени срещу
 * node_modules/three/src/renderers/shaders/ShaderChunk за 0.180; липсващ
 * chunk гърми при компилация през materialPatch, което
 * scripts/game/shader-patch-selftest.mjs проверява за всеки вид × клас
 * материал без WebGL (кръпката се пуска върху ShaderLib текста). Използвани
 * псевдоними от префикса на three за WebGL2: texture2D → texture,
 * texture2DGradEXT → textureGrad, texture2DLodEXT → textureLod (само във
 * фрагмента). Ползвани вградени символи: `rand(vec2)` (common),
 * `nonPerturbedNormal` (normal_fragment_begin), `vViewPosition`, `tbn`,
 * `normalScale`, `reflectedLight`. Никакъв код тук не пипа window/document —
 * модулът се зарежда и в Node.
 */

import * as THREE from 'three';

import { applyPatch, removePatch } from './materialPatch.js';
import { getNoiseTexture } from './noiseTex.js';
import { curvatureRanges } from './sim.js';

/** Име на кръпката в materialPatch — една на материал. */
export const PATCH_NAME = 'surface';

/**
 * Метричната UV на геометрията е u = aLateral / 4, v = aAlong / 4 (4 m на
 * единица); texture.repeat = UV_METRE_UNIT / tile дава тайл в метри.
 */
export const UV_METRE_UNIT = 4;

/** Размер на тайла в метри по вид настилка (десктоп и телефон еднакво). */
export const SURFACE_TILES = Object.freeze({
    asphalt: 2.0,
    runoff: 2.0,
    grass: 2.5,
    gravel: 3.0,
    terrain: 2.6,
});

/** Видовете, които applySurfaceShaders разпознава в подадения обект. */
export const SURFACE_KINDS = Object.freeze(['asphalt', 'runoff', 'grass', 'gravel', 'terrain', 'kerb']);

/** Диапазон на кодираното отместване на линията в профила: ±SPAN/2 метра. */
const LINE_SPAN = 20;

/** Условна височина на облачния слой (m) — за отместването на сянката по слънцето. */
const CLOUD_HEIGHT = 600;

/** Период на облачния шум по земята (m) — същият в GLSL (1.0 / 900.0). */
const CLOUD_PERIOD = 900;

/** Дрейф на облаците в UV единици/секунда при speed 1 (≈ 3.6 m/s вятър). */
const CLOUD_DRIFT = 0.004;

/**
 * texture.repeat за карта върху метрична UV, така че тайлът да е
 * SURFACE_TILES[kind] метра и по двете оси.
 *
 * @param {string} kind
 * @returns {number}
 */
export function surfaceRepeat(kind) {
    return UV_METRE_UNIT / (SURFACE_TILES[kind] ?? SURFACE_TILES.asphalt);
}

/**
 * @typedef {object} SurfaceFeatures
 * @property {boolean} attributes   Чете aLateral/aAlong/aHalfWidth (varying vSurf)
 * @property {boolean} worldUv      UV от световните xz (терен) вместо vMapUv
 * @property {boolean} antiTile     Хеширани 2 tap-а за map/normal/roughness
 * @property {boolean} macro        Нискочестотен тон от шума
 * @property {boolean} rubber       Гумирана състезателна линия (+ спирачно износване)
 * @property {boolean} marbles      Светли мрамори извън линията в завоите
 * @property {boolean} streak       Отделен шумов tap за ивиците по линията
 * @property {boolean} lines        Аналитични крайни линии + стартова лента
 * @property {boolean} patches      Ремонтни кръпки 4×9 m
 * @property {boolean} detailNormal Второ семплиране на normalMap отблизо
 * @property {boolean} shoulder     Изтъркан кафяв банкет до асфалта (трева)
 * @property {boolean} cloud        Облачни сенки върху директната светлина
 * @property {boolean} cloudDetail  Втори облачен tap
 * @property {'full'|'sheen'|'mild'|false} wet  Режим на мокрото
 * @property {boolean} puddles      Локви (само wet 'full' на десктоп)
 * @property {boolean} distanceFade Избледняване на тайла към средния цвят далече
 * @property {boolean} nightSheen   По-гланцов асфалт под прожектори
 * @property {boolean} fineNoise    Нужен е вторият (фин) шумов tap
 */

/**
 * Флаговете на ефектите за даден вид настилка и устройство.
 *
 * @param {string} kind
 * @param {{detail?: boolean, cloud?: boolean, night?: boolean}} [context]
 * @returns {SurfaceFeatures}
 */
export function surfaceFeatures(kind, context = {}) {
    const detail = context.detail !== false;
    const cloud = context.cloud === true;
    const night = context.night === true;

    const base = {
        attributes: false,
        worldUv: false,
        antiTile: false,
        macro: false,
        rubber: false,
        marbles: false,
        streak: false,
        lines: false,
        patches: false,
        detailNormal: false,
        shoulder: false,
        cloud,
        cloudDetail: cloud && detail,
        wet: false,
        puddles: false,
        distanceFade: false,
        nightSheen: false,
        fineNoise: false,
    };

    switch (kind) {
        case 'asphalt':
            return {
                ...base,
                attributes: true,
                antiTile: detail,
                macro: true,
                rubber: true,
                marbles: detail,
                streak: detail,
                lines: true,
                patches: detail,
                detailNormal: detail,
                wet: 'full',
                puddles: detail,
                nightSheen: night,
                fineNoise: detail,
            };
        case 'runoff':
            return {
                ...base,
                attributes: true,
                antiTile: detail,
                macro: true,
                detailNormal: detail,
                wet: 'full',
                puddles: detail,
                nightSheen: night,
                fineNoise: detail,
            };
        case 'grass':
            return { ...base, attributes: true, antiTile: detail, macro: true, shoulder: true, wet: 'mild' };
        case 'gravel':
            return { ...base, antiTile: detail, macro: true, wet: 'mild' };
        case 'terrain':
            return { ...base, worldUv: true, antiTile: detail, macro: true, distanceFade: true, wet: 'mild' };
        case 'kerb':
            return { ...base, wet: 'sheen', nightSheen: night };
        default:
            throw new RangeError(`surfaceShader: непознат вид настилка „${kind}"`);
    }
}

/**
 * Пече профилната текстура на пистата (count × 1, RGBA8, RepeatWrapping по
 * u, за да се затвори кръгът на S/F).
 *
 *   R: raceOffset (±LINE_SPAN/2 m → 0..1)
 *   G: мрамори = clamp(|raceCurv| · 60) — пълни при радиус ≤ 50 m
 *   B: спирачна зона 0..1 (същите събития като табелите/следите в decor:
 *      curvatureRanges(0.02, 3), слети под 12 реда, 110 m преди, 12 m след)
 *   A: равнинност 1 − clamp(|банкинг|·40 + |наклон|·25) — локвите стоят
 *      само където напречният наклон е под ~2.5 %
 *
 * @param {import('./track.js').Track} track
 * @returns {THREE.DataTexture}
 */
export function buildTrackProfileTexture(track) {
    const { count, spacing, raceOffset, raceCurv, bankSlope, gradient } = track;
    const data = new Uint8Array(count * 4);
    const brake = new Float32Array(count);

    const events = [];
    for (const range of curvatureRanges(track, 0.02, 3)) {
        const last = events[events.length - 1];
        if (last && range.from - last.to < 12) {
            last.to = range.to;
        } else {
            events.push({ from: range.from, to: range.to });
        }
    }
    const lead = Math.round(110 / spacing);
    const tail = Math.round(12 / spacing);
    for (const event of events) {
        const rows = lead + tail + 1;
        for (let r = 0; r < rows; r++) {
            const i = (((event.from - lead + r) % count) + count) % count;
            brake[i] = Math.max(brake[i], smoothstep(0.15, 0.95, r / rows));
        }
    }

    for (let i = 0; i < count; i++) {
        const offset = raceOffset ? raceOffset[i] : 0;
        const curv = raceCurv ? Math.abs(raceCurv[i]) : 0;
        const bank = bankSlope ? Math.abs(bankSlope[i]) : 0;
        const grade = gradient ? Math.abs(gradient[i]) : 0;
        data[i * 4] = toByte(offset / LINE_SPAN + 0.5);
        data[i * 4 + 1] = toByte(curv * 60);
        data[i * 4 + 2] = toByte(brake[i]);
        data[i * 4 + 3] = toByte(1 - Math.min(1, bank * 40 + grade * 25));
    }

    const texture = new THREE.DataTexture(data, count, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.name = `surface-profile-${track.slug ?? 'track'}`;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    return texture;
}

/**
 * Споделените uniform обекти — ЕДИН набор за всички кърпени материали
 * (пазят се по референция в кръпките; сменя се само .value).
 *
 * @param {import('./track.js').Track} track
 * @param {{cloudTexture?: THREE.Texture|null, noiseTexture?: THREE.Texture|null}} [options]
 * @returns {Record<string, {value: unknown}>}
 */
export function createSurfaceUniforms(track, options = {}) {
    const noise = options.noiseTexture ?? getNoiseTexture(256);
    const period = track.count * track.spacing;

    return {
        uTime: { value: 0 },
        uWet: { value: 0 },
        uNightSheen: { value: 0 },
        uStartS: { value: 0 },
        uTrackLength: { value: period },
        uProfileScale: { value: 1 / period },
        // Тексел i е центриран на (i + 0.5) / count, а ред i е на i·spacing.
        uProfileOffset: { value: 0.5 / track.count },
        uCloudOffset: { value: new THREE.Vector2() },
        uCloudStrength: { value: 0 },
        tNoise: { value: noise },
        tCloud: { value: options.cloudTexture ?? noise },
        tProfile: { value: buildTrackProfileTexture(track) },
    };
}

/**
 * Кърпи един материал за даден вид настилка. По-ниското ниво на
 * applySurfaceShaders — за клонинги (buildOpponentRig не кърпи настилки,
 * но terrain.js може да върне повече от един материал).
 *
 * @param {THREE.Material} material
 * @param {string} kind
 * @param {SurfaceFeatures} features
 * @param {Record<string, {value: unknown}>} uniforms
 * @returns {THREE.Material}
 */
export function patchSurfaceMaterial(material, kind, features, uniforms) {
    if (!material?.isMaterial) {
        throw new TypeError(`surfaceShader: „${kind}" не е three.js Material`);
    }
    // Standard/Physical (isMeshStandardMaterial е true и за Physical) имат
    // roughness pipeline; Lambert/Basic/Phong — не, и техният шейдър няма
    // <roughnessmap_fragment>. Определя се по материала, за да не гърми
    // materialPatch при подмяна на липсващ chunk.
    const patch = buildPatch(kind, features, { pbr: material.isMeshStandardMaterial === true });
    patch.uniforms = pickUniforms(uniforms, patch.uniformNames);
    delete patch.uniformNames;
    material.userData.surface = { kind, features };

    return applyPatch(material, patch);
}

/**
 * @typedef {object} SurfaceController
 * @property {Record<string, {value: unknown}>} uniforms
 * @property {Record<string, SurfaceFeatures>} features  По вид, само за кърпените материали
 * @property {(dt: number, camera?: THREE.Camera, sunDir?: THREE.Vector3) => void} update
 * @property {(value: number) => void} setWet             0 сухо … 1 мокро (без прекомпилация)
 * @property {(value: number) => void} setCloudStrength   0..1 (действа само ако видът е компилиран с облаци)
 * @property {(value: number) => void} setNightSheen      0..1
 * @property {(metres: number) => void} setStartS         Позиция на стартовата лента по aAlong
 * @property {() => void} dispose                         Освобождава профила и маха кръпките
 */

/**
 * Кърпи всички подадени повърхностни материали и връща контролера им.
 *
 * @param {Partial<Record<'asphalt'|'runoff'|'grass'|'gravel'|'terrain'|'kerb', THREE.Material|THREE.Material[]>>} materials
 * @param {import('./track.js').Track} track
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @param {{
 *   lowPower?: boolean,
 *   quality?: object,
 *   detail?: boolean,
 *   cloudTexture?: THREE.Texture|null,
 *   noiseTexture?: THREE.Texture|null,
 *   cloudStrength?: number|null,
 *   wet?: number,
 *   startS?: number,
 * }} [options]
 * @returns {SurfaceController}
 */
export function applySurfaceShaders(materials, track, circuit, options = {}) {
    const lowPower = options.lowPower === true;
    const detail = options.detail ?? !lowPower;
    const look = circuit?.look ?? {};
    const night = circuit?.atmosphere?.night === true || look.preset === 'night';
    const cloudStrength = clamp01(options.cloudStrength ?? cloudStrengthFor(look, night));

    const uniforms = createSurfaceUniforms(track, options);
    uniforms.uCloudStrength.value = cloudStrength;
    uniforms.uWet.value = clamp01(options.wet ?? 0);
    uniforms.uNightSheen.value = night ? 1 : 0;
    uniforms.uStartS.value = options.startS ?? 0;

    /** @type {Array<THREE.Material>} */
    const patched = [];
    /** @type {Record<string, SurfaceFeatures>} */
    const features = {};
    for (const kind of SURFACE_KINDS) {
        const entry = materials?.[kind];
        const list = Array.isArray(entry) ? entry : entry ? [entry] : [];
        if (list.length === 0) {
            continue;
        }
        features[kind] = surfaceFeatures(kind, { detail, cloud: cloudStrength > 0, night });
        for (const material of list) {
            patchSurfaceMaterial(material, kind, features[kind], uniforms);
            patched.push(material);
        }
    }

    // Посоката на вятъра е детерминирана по пистата — една и съща при всяко
    // зареждане (визуален шум, не сим).
    const windAngle = (hashString(track.slug ?? 'track') % 360) * (Math.PI / 180);
    const windDir = new THREE.Vector2(Math.cos(windAngle), Math.sin(windAngle));
    const cloudSpeed = Number.isFinite(look.clouds?.speed) ? look.clouds.speed : 1;
    const drift = new THREE.Vector2();
    const projection = new THREE.Vector2();
    let disposed = false;

    /**
     * @param {number} dt
     * @param {THREE.Camera} [camera] Част от общия договор; засега няма камерно-зависим ефект
     * @param {THREE.Vector3} [sunDir] Единичен вектор КЪМ слънцето
     */
    const update = (dt, camera, sunDir) => {
        if (disposed || !(dt > 0)) {
            return;
        }
        uniforms.uTime.value = (uniforms.uTime.value + dt) % 1000;
        drift.addScaledVector(windDir, dt * CLOUD_DRIFT * cloudSpeed);
        if (sunDir && sunDir.y > 0.05) {
            // Сянката на облак на височина H пада на H·tan(зенитен ъгъл) встрани
            // от него — по посока, обратна на слънцето.
            const k = -(CLOUD_HEIGHT / CLOUD_PERIOD) / Math.max(sunDir.y, 0.2);
            projection.set(sunDir.x * k, sunDir.z * k);
        }
        uniforms.uCloudOffset.value.set(drift.x + projection.x, drift.y + projection.y);
    };

    return {
        uniforms,
        features,
        update,
        setWet: (value) => {
            uniforms.uWet.value = clamp01(value);
        },
        setCloudStrength: (value) => {
            uniforms.uCloudStrength.value = clamp01(value);
        },
        setNightSheen: (value) => {
            uniforms.uNightSheen.value = clamp01(value);
        },
        setStartS: (metres) => {
            uniforms.uStartS.value = Number.isFinite(metres) ? metres : 0;
        },
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const material of patched) {
                removePatch(material, PATCH_NAME);
                delete material.userData.surface;
            }
            uniforms.tProfile.value.dispose();
        },
    };
}

// ── GLSL ────────────────────────────────────────────────────────────────

/**
 * Сглобява кръпката за вид + флагове. Целият GLSL се генерира от флаговете,
 * така че ключът на програмата (materialPatch хешира текста) различава
 * наборите; еднакви набори споделят програма.
 *
 * @param {string} kind
 * @param {SurfaceFeatures} f
 * @param {{pbr?: boolean}} [target]  pbr=false: материал без roughness (Lambert) —
 *   без подмяна на `roughnessmap_fragment`
 * @returns {import('./materialPatch.js').MaterialPatch & {uniformNames: string[]}}
 */
function buildPatch(kind, f, target = {}) {
    const pbr = target.pbr !== false;
    const profile = f.attributes && (f.rubber || f.marbles || f.wet === 'full');
    const flatten = f.lines || f.puddles;
    const uniformNames = ['tNoise'];

    // ── Вертекс ──
    const vertexHead = [];
    const vertexMain = [];
    if (f.attributes) {
        vertexHead.push('attribute float aLateral;', 'attribute float aAlong;', 'attribute float aHalfWidth;', 'varying vec3 vSurf;');
        vertexMain.push('vSurf = vec3(aLateral, aAlong, aHalfWidth);');
    }
    vertexHead.push('varying vec3 vSurfWorld;');
    vertexMain.push(
        '{',
        '    vec4 sWp = vec4(transformed, 1.0);',
        '    #ifdef USE_INSTANCING',
        '    sWp = instanceMatrix * sWp;',
        '    #endif',
        '    vSurfWorld = (modelMatrix * sWp).xyz;',
        '}'
    );

    // ── Фрагмент: декларации ──
    const fragmentHead = [`// surfaceShader: ${kind}`];
    if (f.attributes) {
        fragmentHead.push('varying vec3 vSurf;');
    }
    fragmentHead.push('varying vec3 vSurfWorld;', 'uniform sampler2D tNoise;');
    if (profile) {
        fragmentHead.push('uniform sampler2D tProfile;', 'uniform float uProfileScale;', 'uniform float uProfileOffset;');
        uniformNames.push('tProfile', 'uProfileScale', 'uProfileOffset');
    }
    if (f.lines) {
        fragmentHead.push('uniform float uStartS;', 'uniform float uTrackLength;');
        uniformNames.push('uStartS', 'uTrackLength');
    }
    if (f.wet) {
        fragmentHead.push('uniform float uWet;');
        uniformNames.push('uWet');
    }
    if (f.nightSheen) {
        fragmentHead.push('uniform float uNightSheen;');
        uniformNames.push('uNightSheen');
    }
    if (f.cloud) {
        fragmentHead.push('uniform sampler2D tCloud;', 'uniform vec2 uCloudOffset;', 'uniform float uCloudStrength;');
        uniformNames.push('tCloud', 'uCloudOffset', 'uCloudStrength');
    }
    if (f.antiTile) {
        fragmentHead.push(
            // Quilez „texture repetition" #1: две виртуални копия с хеширани
            // отмествания, смесени по нискочестотен индекс. textureGrad с
            // производните на НЕотместеното uv — отместването е константа по
            // парче и не бива да влиза в избора на mip ниво.
            'vec4 surfNoTile(sampler2D tex, vec2 uv, vec2 offA, vec2 offB, float blend) {',
            '    vec2 dx = dFdx(uv);',
            '    vec2 dy = dFdy(uv);',
            '    return mix(texture2DGradEXT(tex, uv + offA, dx, dy), texture2DGradEXT(tex, uv + offB, dx, dy), blend);',
            '}'
        );
    }

    const mapUv = f.worldUv ? 'sUv' : 'vMapUv';
    const roughUv = f.worldUv ? 'sUv' : 'vRoughnessMapUv';
    const normalUv = f.worldUv ? 'sUv' : 'vNormalMapUv';
    const sample = (sampler, uv) => (f.antiTile ? `surfNoTile(${sampler}, ${uv}, sOffA, sOffB, sBlend)` : `texture2D(${sampler}, ${uv})`);

    // ── map_fragment: общите локали живеят до края на main() ──
    const map = ['vec4 sNoiseL = texture2D(tNoise, vSurfWorld.xz * (1.0 / 90.0));'];
    if (f.fineNoise) {
        map.push('vec4 sNoiseH = texture2D(tNoise, vSurfWorld.xz * (1.0 / 6.0));');
    }
    if (f.antiTile) {
        map.push(
            'vec2 sOffA;',
            'vec2 sOffB;',
            'float sBlend;',
            '{',
            '    float sIdx = sNoiseL.g * 8.0;',
            '    float sIa = floor(sIdx);',
            '    sOffA = sin(vec2(3.0, 7.0) * sIa);',
            '    sOffB = sin(vec2(3.0, 7.0) * (sIa + 1.0));',
            '    sBlend = smoothstep(0.2, 0.8, fract(sIdx));',
            '}'
        );
    }
    if (f.worldUv) {
        map.push(`vec2 sUv = vSurfWorld.xz * (1.0 / ${glslFloat(SURFACE_TILES.terrain)});`);
    }
    if (f.distanceFade) {
        map.push('float sFade = smoothstep(150.0, 300.0, length(vViewPosition));');
    }
    // Блоковете под USE_MAP/USE_ROUGHNESSMAP се емитират винаги (кербът днес
    // няма карта, но ако получи — да не бъде тихо игнорирана).
    map.push('#ifdef USE_MAP', `    vec4 sampledDiffuseColor = ${sample('map', mapUv)};`);
    map.push('    #ifdef DECODE_VIDEO_TEXTURE', '    sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );', '    #endif');
    if (f.distanceFade) {
        // Далече тайлът избледнява към средния цвят на картата (най-грубото
        // mip ниво) — mip moiré и повторението изчезват преди мъглата.
        map.push(`    sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, texture2DLodEXT(map, ${mapUv}, 10.0).rgb, sFade);`);
    }
    map.push('    diffuseColor *= sampledDiffuseColor;', '#endif');
    if (f.macro) {
        map.push('diffuseColor.rgb *= 0.85 + 0.3 * sNoiseL.r;');
    }
    if (f.attributes) {
        // Стара геометрия без атрибути → aHalfWidth = 0 → ефектите по линията
        // се изключват, вместо да рисуват боклук.
        map.push('float sHas = step(0.05, vSurf.z);');
    }
    if (profile) {
        map.push('vec4 sProf = texture2D(tProfile, vec2(vSurf.y * uProfileScale + uProfileOffset, 0.5));');
    }
    if (f.rubber) {
        map.push(`float sD = vSurf.x - (sProf.r - 0.5) * ${glslFloat(LINE_SPAN)};`);
        if (f.streak) {
            // Ивици: бавен шум по дължина (период 45 m), бърз напречно (2.5 m).
            map.push('vec4 sStreak = texture2D(tNoise, vec2(vSurf.x * 0.4, vSurf.y * 0.022));', 'float sStreakK = sStreak.r;', 'float sWearK = sStreak.g;');
        } else {
            map.push('float sStreakK = sNoiseL.b;', 'float sWearK = 0.5;');
        }
        map.push(
            // Гаусов профил σ ≈ 0.9 m около линията.
            'float sRub = exp(-sD * sD * 0.625) * (0.85 + 0.3 * sStreakK) * sHas;',
            'diffuseColor.rgb *= 1.0 - 0.32 * sRub;',
            // Спирачни зони: по-тъмни ивици точно по гумата.
            'float sBrake = sProf.b * sRub;',
            'diffuseColor.rgb *= 1.0 - 0.2 * sBrake * (0.6 + 0.4 * sWearK);'
        );
    }
    if (f.marbles) {
        map.push(
            'float sAd = abs(sD);',
            'float sMarb = smoothstep(1.8, 2.6, sAd) * (1.0 - smoothstep(3.2, 4.0, sAd)) * sProf.g * sHas;',
            'diffuseColor.rgb *= 1.0 + 0.10 * sMarb * step(0.62, sNoiseH.r);'
        );
    }
    if (f.patches) {
        map.push(
            // Ремонтни кръпки: хеш-клетки 4 × 9 m в координатите на лентата,
            // ~7 % от клетките, с мек ръб и само вътре в асфалта.
            'vec2 sPc = vec2(vSurf.x * 0.25, vSurf.y * (1.0 / 9.0));',
            'vec2 sPf = fract(sPc);',
            'float sPatch = step(0.93, rand(floor(sPc) * 0.013 + 0.29))',
            '    * smoothstep(0.0, 0.06, sPf.x) * smoothstep(0.0, 0.06, 1.0 - sPf.x)',
            '    * smoothstep(0.0, 0.03, sPf.y) * smoothstep(0.0, 0.03, 1.0 - sPf.y)',
            '    * step(abs(vSurf.x) + 0.4, vSurf.z) * sHas;',
            'diffuseColor.rgb *= 1.0 - 0.18 * sPatch;'
        );
    }
    if (f.lines) {
        map.push(
            // Крайна линия: последните 18 cm на асфалта, с fwidth — далече
            // линията се разтваря в покритието си вместо да шимъри.
            // max(): smoothstep с edge0 == edge1 е недефиниран, а fwidth може да
            // е точно 0 върху константен quad.
            'float sE = vSurf.z - abs(vSurf.x);',
            'float sAa = max(fwidth(sE), 1e-4);',
            'float sLine = smoothstep(0.0, sAa, sE) * (1.0 - smoothstep(0.18, 0.18 + sAa, sE)) * sHas;'
        );
        if (f.fineNoise) {
            map.push('sLine *= 0.92 + 0.08 * sNoiseH.g;');
        }
        map.push(
            // Стартова лента ±0.6 m около uStartS, шах 8 клетки напречно.
            'float sStartD = mod(vSurf.y - uStartS + 0.5 * uTrackLength, uTrackLength) - 0.5 * uTrackLength;',
            'float sStart = (1.0 - smoothstep(0.6, 0.6 + max(fwidth(sStartD), 1e-4), abs(sStartD))) * sHas;',
            'sStart *= mod(floor((sStartD + 0.6) * (1.0 / 0.6)) + floor((vSurf.x / max(vSurf.z, 0.05) + 1.0) * 4.0), 2.0);',
            'float sPaint = max(sLine, sStart);',
            // 0.80 линейно (≈ 0.91 sRGB): бяла боя, която не прегаря под 2.7× слънце.
            'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80), sPaint);'
        );
    }
    if (f.shoulder) {
        map.push(
            'float sShoulder = (1.0 - smoothstep(0.2, 1.4, abs(vSurf.x) - vSurf.z)) * sHas;',
            'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.52, 0.40), sShoulder * (0.5 + 0.5 * sNoiseL.b));'
        );
    }
    if (f.wet === 'full') {
        if (f.puddles) {
            map.push('float sPuddle = smoothstep(0.62, 0.72, sNoiseL.a * 0.6 + sNoiseH.b * 0.4) * sProf.a * uWet * sHas;');
        } else {
            map.push('float sPuddle = 0.0;');
        }
        map.push('float sWetK = uWet * mix(0.55, 1.0, sPuddle);', 'diffuseColor.rgb *= mix(1.0, 0.42, sWetK);');
    } else if (f.wet === 'sheen') {
        map.push('float sWetK = uWet * 0.8;', 'diffuseColor.rgb *= mix(1.0, 0.6, uWet);');
    } else if (f.wet === 'mild') {
        map.push('diffuseColor.rgb *= mix(1.0, 0.72, uWet);');
    }

    // ── roughnessmap_fragment ──
    const rough = ['float roughnessFactor = roughness;'];
    rough.push('#ifdef USE_ROUGHNESSMAP', `    vec4 texelRoughness = ${sample('roughnessMap', roughUv)};`, '    roughnessFactor *= texelRoughness.g;', '#endif');
    if (f.rubber) {
        // Гумата полира леко агрегата, без сухият асфалт да изглежда мокър.
        rough.push('roughnessFactor *= 1.0 - 0.10 * sRub;', 'roughnessFactor *= 1.0 - 0.12 * sBrake;');
    }
    if (f.patches) {
        rough.push('roughnessFactor -= 0.06 * sPatch;');
    }
    if (kind === 'asphalt') {
        // Прагът е само за сухия агрегат. Боята, нощното осветление и локвите
        // запазват собствения си блясък в следващите слоеве.
        rough.push('roughnessFactor = max(roughnessFactor, 0.68);');
    }
    if (f.lines) {
        rough.push('roughnessFactor = mix(roughnessFactor, 0.45, sPaint);');
    }
    if (f.shoulder) {
        rough.push('roughnessFactor = mix(roughnessFactor, 1.0, sShoulder);');
    }
    if (f.nightSheen) {
        rough.push('roughnessFactor *= mix(1.0, 0.65, uNightSheen);');
    }
    if (f.wet === 'full') {
        rough.push('roughnessFactor = mix(roughnessFactor, 0.06, sWetK);');
    } else if (f.wet === 'sheen') {
        rough.push('roughnessFactor = mix(roughnessFactor, 0.12, sWetK);');
    } else if (f.wet === 'mild') {
        rough.push('roughnessFactor *= mix(1.0, 0.8, uWet);');
    }
    rough.push('roughnessFactor = clamp(roughnessFactor, 0.03, 1.0);');

    // ── normal_fragment_maps (само където има какво да се промени) ──
    const replace = [['map_fragment', map.join('\n')]];
    if (pbr) {
        replace.push(['roughnessmap_fragment', rough.join('\n')]);
    }
    if (f.antiTile || f.detailNormal || flatten) {
        const normal = [
            '#ifdef USE_NORMALMAP_OBJECTSPACE',
            '    normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
            '    #ifdef FLIP_SIDED',
            '        normal = - normal;',
            '    #endif',
            '    #ifdef DOUBLE_SIDED',
            '        normal = normal * faceDirection;',
            '    #endif',
            '    normal = normalize( normalMatrix * normal );',
            '#elif defined( USE_NORMALMAP_TANGENTSPACE )',
            `    vec3 mapN = ${sample('normalMap', normalUv)}.xyz * 2.0 - 1.0;`,
        ];
        if (f.detailNormal) {
            normal.push(
                // Зърното на асфалта отблизо: второ семплиране ×8.3 (UDN
                // смесване по xy), угасва между 25 и 60 m.
                '    {',
                `        vec3 sN2 = texture2D(normalMap, ${normalUv} * 8.3).xyz * 2.0 - 1.0;`,
                '        mapN.xy += sN2.xy * 0.45 * (1.0 - smoothstep(25.0, 60.0, length(vViewPosition)));',
                '    }'
            );
        }
        normal.push(
            '    mapN.xy *= normalScale;',
            '    normal = normalize( tbn * mapN );',
            '#elif defined( USE_BUMPMAP )',
            '    normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );',
            '#endif'
        );
        if (flatten) {
            // Боята и локвите са гладки: релефът на картата се приглажда към
            // геометричната нормала (geometryNormal още не съществува тук).
            const terms = [];
            if (f.lines) {
                terms.push('sPaint * 0.6');
            }
            if (f.puddles) {
                terms.push('sPuddle * 0.9');
            }
            normal.push(`normal = normalize(mix(normal, nonPerturbedNormal, clamp(${terms.join(' + ')}, 0.0, 1.0)));`);
        }
        replace.push(['normal_fragment_maps', normal.join('\n')]);
    }

    // ── lights_fragment_begin: облачни сенки САМО върху директната светлина ──
    if (f.cloud) {
        const cloud = ['#include <lights_fragment_begin>', '{', '    float sC1 = texture2D(tCloud, vSurfWorld.xz * (1.0 / 900.0) + uCloudOffset).r;'];
        if (f.cloudDetail) {
            cloud.push(
                '    float sC2 = texture2D(tCloud, vSurfWorld.xz * (1.0 / 390.0) - uCloudOffset * 0.6).r;',
                '    float sCloud = smoothstep(0.35, 0.75, sC1 * 0.7 + sC2 * 0.3);'
            );
        } else {
            cloud.push('    float sCloud = smoothstep(0.35, 0.75, sC1);');
        }
        cloud.push(
            '    float sCloudK = 1.0 - 0.55 * sCloud * uCloudStrength;',
            '    reflectedLight.directDiffuse *= sCloudK;',
            '    reflectedLight.directSpecular *= sCloudK;',
            '}'
        );
        replace.push(['lights_fragment_begin', cloud.join('\n')]);
    }

    return {
        name: PATCH_NAME,
        uniformNames,
        vertexHead: vertexHead.join('\n'),
        vertexMain: vertexMain.join('\n'),
        fragmentHead: fragmentHead.join('\n'),
        replace,
    };
}

// ── Помощни ─────────────────────────────────────────────────────────────

/**
 * Само uniform-ите, които GLSL-ът декларира — three предупреждава за
 * uniform без употреба само в debug, но по-важно: ключът остава чист.
 *
 * @param {Record<string, {value: unknown}>} uniforms
 * @param {string[]} names
 * @returns {Record<string, {value: unknown}>}
 */
function pickUniforms(uniforms, names) {
    const picked = {};
    for (const name of names) {
        picked[name] = uniforms[name];
    }

    return picked;
}

/**
 * Сила на облачните сенки по look: boolean → 0.7, число → clamp, липсва →
 * 0.6 денем (нула нощем — прожекторите нямат облаци).
 *
 * @param {object} look
 * @param {boolean} night
 * @returns {number}
 */
function cloudStrengthFor(look, night) {
    const value = look.cloudShadow;
    if (typeof value === 'number') {
        return clamp01(value);
    }
    if (typeof value === 'boolean') {
        return value ? 0.7 : 0;
    }

    return night ? 0 : 0.6;
}

/**
 * Число като GLSL float литерал (винаги с десетична точка).
 *
 * @param {number} value
 * @returns {string}
 */
function glslFloat(value) {
    const text = String(value);

    return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * @param {number} value 0..1
 * @returns {number} 0..255
 */
function toByte(value) {
    return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

/**
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));

    return t * t * (3 - 2 * t);
}

/**
 * FNV-1a хеш на низ (копие — без зависимост към Game.js).
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
