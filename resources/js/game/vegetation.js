/**
 * Растителност: жива гора, банкет и птици.
 *
 * Дърветата идват от OSM (track.landmarks.trees: [x, z, scale]) и се сгъстяват
 * по circuit.treeDensity — същият път като стария buildTrees в mesh.js, но:
 *   - всяка инстанция има собствен цвят (HSL jitter през instanceColor),
 *     мащаб по писта (look.treeScale: Монца 20-25 m) и случаен yaw;
 *   - короните се люлеят от вятър във vertex шейдъра (кръпка през
 *     materialPatch — и в depth материала, за да се люлее и сянката);
 *   - LOD по разстояние от осевата линия, решено ПРИ СТРОЕЖА: до 140 m
 *     3D геометрия (камерата никога не е по-далеч от ~10 m от оста, така че
 *     нищо близко не е билборд), отвъд — кръстосани квадрати с процедурен
 *     атлас. Няма per-frame размяна на LOD и няма „попване";
 *   - близката гора е нарязана на парчета по ~700 m трасе, всяко със своя
 *     bounding sphere: frustum culling-ът реално маха работа, когато гората
 *     е зад камерата (една сфера за цялата писта не се изрязва никога);
 *   - тревни туфи и храсти по банкета (клирънс от асфалта както при
 *     дърветата), сухи храсти при пясъчен терен; ято птици денем.
 *
 * Всичко е детерминирано (hashNoise, seed от slug) — без Math.random —
 * и чисто визуално: симулацията никога не чете този модул. Модулът не пипа
 * document/window при зареждане; canvas текстурите се правят при строеж и
 * липсват тихо в Node (селфтестове).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyPatch } from './materialPatch.js';
import { runoffRanges } from './sim.js';
import { createCanopyTexture, createTreeGeometry, patchCanopyNormals } from './treeCanopy.js';

/**
 * Посоката на вятъра в XZ (единичен вектор). Една за цялата сцена — знамена,
 * дим и облаци четат същата, иначе гората се люлее срещу знамето.
 */
export const WIND_DIR = Object.freeze(new THREE.Vector2(0.8, 0.6));

/** Отвъд това разстояние от осевата линия дървото е билборд. */
const LOD_DISTANCE = 140;

/** Клирънс на дърво от осевата линия: полуширина + това (покрива run-off). */
const TREE_CLEARANCE_EXTRA = 9;

/** Дължина трасе (m) на едно парче близка гора — компромис draw calls / culling. */
const NEAR_CHUNK_METRES = 700;

/** Парче с по-малко инстанции се слива с предишното — draw call за 10 дървета е загуба. */
const NEAR_CHUNK_MIN = 30;

/**
 * При такава плътност пистата е „гора" (Монца, Спа, Имола…), а OSM дава по
 * едно дърво на площ и спира на 400 m: запълваме по шум — 3D дървета до LOD
 * прага (тунелът от зеленина) и билборди до фона. Поляните остават там,
 * където шумът е под прага; ориентирите (трибуни, сгради) и стартовата права
 * се пропускат.
 */
const FOREST_FILL_MIN_DENSITY = 1.8;
const FOREST_FILL_NEAR = { from: 4, to: LOD_DISTANCE, spacing: 14, threshold: 0.42 };
const FOREST_FILL_FAR = { from: LOD_DISTANCE, to: 650, spacing: 24, threshold: 0.5 };
const FOREST_FILL_START_CLEAR = 80;

/**
 * Construction-time профили. Auto и High са старите стойности едно към едно.
 * Low/Medium режат самите инстанции, не само shader ефекти; Ultra добавя 23%
 * клонинги в съществуващите близки forest chunks и до 20% детайл по вержа.
 * Така броят InstancedMesh/material draw calls не расте. lowPower винаги печели
 * пред избраното качество и остава на стария мобилен таван.
 *
 * | profile  | near | total | tufts | bushes | retained/detail |
 * |----------|-----:|------:|------:|-------:|----------------:|
 * | low      | 1300 |  3000 |  2000 |    450 |             50% |
 * | medium   | 2000 |  4500 |  3000 |    675 |             75% |
 * | auto/high| 2600 |  6000 |  4000 |    900 |            100% |
 * | ultra    | 3200 |  7200 |  4800 |   1080 |       123%/120% |
 * | lowPower | 1200 |  3200 |  1200 |    400 | old mobile caps |
 */
const VEGETATION_PROFILES = Object.freeze({
    low: Object.freeze({ name: 'low', near: 1300, total: 3000, tufts: 2000, bushes: 450, retain: 0.5, verge: 0.5 }),
    medium: Object.freeze({ name: 'medium', near: 2000, total: 4500, tufts: 3000, bushes: 675, retain: 0.75, verge: 0.75 }),
    high: Object.freeze({ name: 'high', near: 2600, total: 6000, tufts: 4000, bushes: 900, retain: 1, verge: 1 }),
    ultra: Object.freeze({ name: 'ultra', near: 3200, total: 7200, tufts: 4800, bushes: 1080, retain: 1, verge: 1.2 }),
    lowPower: Object.freeze({ name: 'lowPower', near: 1200, total: 3200, tufts: 1200, bushes: 400, retain: 1, verge: 1 }),
});

/**
 * @param {boolean} lowPower
 * @param {object|null|undefined} quality
 * @returns {object}
 */
function vegetationProfile(lowPower, quality) {
    if (lowPower) {
        return VEGETATION_PROFILES.lowPower;
    }
    if (quality?.csmQuality === 'ultra' || quality?.ao === true) {
        return VEGETATION_PROFILES.ultra;
    }
    if (quality?.csmQuality === 'low') {
        return VEGETATION_PROFILES.low;
    }
    if (quality?.csmQuality === 'medium') {
        return VEGETATION_PROFILES.medium;
    }

    // `auto`, `high` и липсващ профил пазят досегашната геометрия.
    return VEGETATION_PROFILES.high;
}

/**
 * Мащаб по подразбиране, когато look.treeScale липсва: старите 8 m корони
 * никога не правеха „тунел от зеленина"; 1.6-1.7 дава 13-15 m дървета.
 */
const DEFAULT_TREE_SCALE = { deciduous: 1.7, conifer: 1.6, mixed: 1.65, shrub: 1.0 };

/** Пълна височина на геометрията по вид в локални единици (за билбордите). */
const TREE_HEIGHT = { deciduous: 8.9, conifer: 10.4, shrub: 1.8 };

const COLORS = {
    trunk: 0x4a3728,
    bird: 0x1c1b1f,
    dryBush: 0x8c7f52,
    tuft: 0x5a8a3c,
};

/**
 * Огледало на тревната лента в mesh.js (Y.grass, RUNOFF_DROP, RUNOFF_WIDTH):
 * туфите стъпват на нея, не на терена (той е ~0.35 m под лентата).
 */
const RIBBON = { y: -0.12, drop: 0.035, width: 8 };

/**
 * Профили на вятъра: от коя локална височина започва люлеенето, къде е
 * пълно и амплитудата (в локални единици — умножава се по мащаба на
 * инстанцията, така че голямото дърво се люлее повече в метри).
 */
const WIND_PROFILES = {
    tree: { y0: 1.5, y1: 7.0, amp: 0.45 },
    billboard: { y0: 0.15, y1: 0.85, amp: 0.05 },
    tuft: { y0: 0.0, y1: 0.5, amp: 0.25 },
    bush: { y0: 0.0, y1: 1.2, amp: 0.12 },
};

const BIRD_COUNT = 16;

const UP = new THREE.Vector3(0, 1, 0);

/**
 * @typedef {object} VegetationOptions
 * @property {boolean} [lowPower]
 * @property {object} [quality]                 game.quality — избира construction-time профила
 * @property {object} [look]                    Замества circuit.look
 * @property {{x: number, y?: number, z?: number}} [windDir]  Посока на вятъра; default look.wind → WIND_DIR
 * @property {Array<Array<number>>} [trees]     Замества track.landmarks.trees
 * @property {{from: number, to: number, sign: number}} [pitRange]  Редове на пит комплекса (decor)
 * @property {(i: number, offset: number) => number} [groundY]  Височина на банкета (terrain.groundY); default — огледало на лентата
 * @property {boolean} [birds]                  Ято птици (default: денем)
 * @property {number} [maxAniso]
 */

/**
 * @typedef {object} Vegetation
 * @property {THREE.Group} group
 * @property {(dt: number, camera?: THREE.Camera, windTime?: number) => void} update
 * @property {() => void} dispose
 * @property {{uWindTime: {value: number}, uWindDir: {value: THREE.Vector2}}} uniforms  Споделени с всички кръпки
 * @property {{near: number, far: number, tufts: number, bushes: number, chunks: number}} stats
 */

/**
 * @param {import('./track.js').Track} track
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @param {{heightAt?: (x: number, z: number) => number, height?: (x: number, z: number) => number}} sampler
 * @param {VegetationOptions} [options]
 * @returns {Vegetation}
 */
export function buildVegetation(track, circuit, sampler, options = {}) {
    const look = resolveLook(circuit, options);
    const profile = vegetationProfile(options.lowPower === true, options.quality);
    const heightAt = sampler.heightAt?.bind(sampler) ?? sampler.height?.bind(sampler);
    if (typeof heightAt !== 'function') {
        throw new TypeError('buildVegetation: семплерът трябва да има heightAt(x, z)');
    }

    const ctx = {
        track,
        circuit,
        look,
        profile,
        lowPower: options.lowPower === true,
        heightAt,
        groundY: options.groundY ?? ((i, offset) => ribbonY(track, i, offset)),
        index: createCentrelineIndex(track),
        startStraight: findStartStraight(track),
        rings: landmarkRings(track),
        uniforms: {
            uWindTime: { value: 0 },
            uWindDir: { value: new THREE.Vector2(look.windDir.x, look.windDir.y) },
        },
        maxAniso: options.maxAniso ?? 4,
        disposables: [],
        depthMaterials: new Map(),
    };

    const group = new THREE.Group();
    group.name = 'vegetation';

    const trees = options.trees ?? track.landmarks?.trees ?? [];
    const { near, far } = collectPlacements(ctx, trees);

    const stats = { near: near.length, far: far.length, tufts: 0, bushes: 0, chunks: 0 };

    for (const mesh of buildNearForest(ctx, near)) {
        group.add(mesh);
        stats.chunks++;
    }

    const billboards = buildBillboards(ctx, far);
    if (billboards) {
        group.add(billboards);
    }

    // Градска писта: банкетът е мантинела и тротоар, туфи няма къде да растат.
    if (!circuit.streetWalls) {
        const verge = buildVergeDetail(ctx, options.pitRange ?? null);
        if (verge.tufts) {
            group.add(verge.tufts);
            stats.tufts = verge.tufts.count;
        }
        if (verge.bushes) {
            group.add(verge.bushes);
            stats.bushes = verge.bushes.count;
        }
    }

    const birds = (options.birds ?? !look.night) ? buildBirdFlock(ctx) : null;
    if (birds) {
        group.add(birds.mesh);
    }

    let ownTime = 0;
    let disposed = false;

    return {
        group,
        uniforms: ctx.uniforms,
        stats,
        update(dt, camera, windTime) {
            if (disposed) {
                return;
            }
            // Общ часовник на вятъра (атмосферата го подава, за да съвпада със
            // знамената); без него броим сами.
            if (typeof windTime === 'number') {
                ctx.uniforms.uWindTime.value = windTime;
            } else {
                ownTime += dt;
                ctx.uniforms.uWindTime.value = ownTime;
            }
            if (birds && camera) {
                birds.update(dt, camera, ctx.uniforms.uWindTime.value);
            }
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            group.traverse((object) => {
                if (object.isInstancedMesh) {
                    object.dispose();
                }
            });
            for (const resource of ctx.disposables) {
                resource.dispose();
            }
            for (const material of ctx.depthMaterials.values()) {
                material.dispose();
            }
            ctx.disposables.length = 0;
            ctx.depthMaterials.clear();
            group.clear();
        },
    };
}

// ── Look ─────────────────────────────────────────────────────────────────

/**
 * Четем circuit.look с defaults (атмосферният пакет го авторства; до тогава
 * и при липсващо поле — старите полета на CircuitStyle).
 *
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @param {VegetationOptions} options
 */
function resolveLook(circuit, options) {
    const look = options.look ?? circuit.look ?? {};
    const kind = circuit.trees ?? 'mixed';
    // Атмосферата авторства look.wind като {x, z}; WIND_DIR е Vector2 {x, y}.
    const windDir = options.windDir ?? look.wind ?? WIND_DIR;
    const windX = windDir.x ?? 0.8;
    const windZ = windDir.z ?? windDir.y ?? 0.6;
    const windLength = Math.hypot(windX, windZ) || 1;

    return {
        kind,
        treeScale: look.treeScale ?? circuit.treeScale ?? DEFAULT_TREE_SCALE[kind] ?? 1,
        treeDensity: look.treeDensity ?? circuit.treeDensity ?? 1,
        terrainKind: look.terrain?.kind ?? inferTerrainKind(circuit),
        night: look.preset === 'night' || circuit.atmosphere?.night === true,
        foliage: circuit.foliage ?? 0x2f5233,
        grassTint: circuit.grassTint ?? 0xffffff,
        windDir: { x: windX / windLength, y: windZ / windLength },
    };
}

/**
 * Без look.terrain.kind познаваме пясъка по цвета на терена: пустинните
 * писти имат топла, светла основа (r доминира), тревните — тъмнозелена.
 *
 * @param {import('./circuits.js').CircuitStyle} circuit
 * @returns {'grass'|'sand'}
 */
function inferTerrainKind(circuit) {
    const base = circuit.terrain?.base ?? 0x24402a;
    const r = (base >> 16) & 0xff;
    const b = base & 0xff;

    return r > 0x95 && r > b + 0x30 ? 'sand' : 'grass';
}

// ── Пространствен индекс на осевата линия ────────────────────────────────

/**
 * Решетка от клетки по 32 m върху осевата линия. Точна най-близка точка до
 * зададено разстояние: пръстени от клетки навън, спираме, щом долната граница
 * на пръстена надхвърли най-доброто. Старият clearOfTrack сканираше всяка
 * втора точка за всяко разположение (Спа: милиони итерации); тук са десетки.
 *
 * @param {import('./track.js').Track} track
 */
function createCentrelineIndex(track) {
    const { xs, zs, count } = track;
    const cell = 32;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
        minX = Math.min(minX, xs[i]);
        maxX = Math.max(maxX, xs[i]);
        minZ = Math.min(minZ, zs[i]);
        maxZ = Math.max(maxZ, zs[i]);
    }

    const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    const rows = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
    const cellOf = (i) => {
        const cx = Math.min(cols - 1, Math.floor((xs[i] - minX) / cell));
        const cz = Math.min(rows - 1, Math.floor((zs[i] - minZ) / cell));
        return cz * cols + cx;
    };

    // CSR: start[c]..start[c+1] са индексите на точките в клетка c.
    const start = new Int32Array(cols * rows + 1);
    for (let i = 0; i < count; i++) {
        start[cellOf(i) + 1]++;
    }
    for (let c = 0; c < cols * rows; c++) {
        start[c + 1] += start[c];
    }
    const fill = start.slice(0, cols * rows);
    const items = new Int32Array(count);
    for (let i = 0; i < count; i++) {
        items[fill[cellOf(i)]++] = i;
    }

    const result = { index: -1, dist: Infinity };

    /**
     * @param {number} x
     * @param {number} z
     * @param {number} maxDist  Отвъд него връща index -1 (dist Infinity)
     * @returns {{index: number, dist: number}} Споделен обект — четете веднага
     */
    const nearest = (x, z, maxDist) => {
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell)));
        const cz = Math.min(rows - 1, Math.max(0, Math.floor((z - minZ) / cell)));
        const maxRings = Math.ceil(maxDist / cell) + 1;
        let best = -1;
        let bestSq = maxDist * maxDist;

        const scanCell = (col, row) => {
            if (col < 0 || row < 0 || col >= cols || row >= rows) {
                return;
            }
            const c = row * cols + col;
            for (let k = start[c]; k < start[c + 1]; k++) {
                const i = items[k];
                const dx = x - xs[i];
                const dz = z - zs[i];
                const d = dx * dx + dz * dz;
                if (d < bestSq) {
                    bestSq = d;
                    best = i;
                }
            }
        };

        for (let r = 0; r <= maxRings; r++) {
            // Точка от пръстен r е поне (r-1) клетки от клетката на заявката.
            const ringMin = (r - 1) * cell;
            if (r > 0 && ringMin * ringMin > bestSq) {
                break;
            }
            if (r === 0) {
                scanCell(cx, cz);
                continue;
            }
            for (let dx = -r; dx <= r; dx++) {
                scanCell(cx + dx, cz - r);
                scanCell(cx + dx, cz + r);
            }
            for (let dz = -r + 1; dz <= r - 1; dz++) {
                scanCell(cx - r, cz + dz);
                scanCell(cx + r, cz + dz);
            }
        }

        result.index = best;
        result.dist = best < 0 ? Infinity : Math.sqrt(bestSq);

        return result;
    };

    return { nearest, minX, maxX, minZ, maxZ };
}

// ── Разположения ─────────────────────────────────────────────────────────

/**
 * @typedef {object} Placement
 * @property {number} x
 * @property {number} z
 * @property {number} s     Мащаб от OSM (площ на короната) × jitter
 * @property {number} seed  Детерминиран seed за цвят/yaw
 * @property {'deciduous'|'conifer'|'shrub'} kind
 * @property {number} row   Най-близък индекс на осевата линия (-1 за запълването)
 * @property {number} dist  Разстояние до осевата линия
 * @property {boolean} [qualityClone] Ultra клонинг в същия kind/track chunk
 */

/**
 * OSM дървета + клонинги по плътност + (при гъста гора) запълване до фона,
 * разделени на близки (3D) и далечни (билборд). При препълване на близкия
 * таван най-далечните минават към билбордите — прагът просто се смъква;
 * далечните се разреждат равномерно (не се режат по ред на обхождане —
 * иначе едната страна на пистата остава гола).
 *
 * @param {object} ctx
 * @param {Array<Array<number>>} trees
 * @returns {{near: Placement[], far: Placement[]}}
 */
function collectPlacements(ctx, trees) {
    const { track, look, profile, index } = ctx;
    const clearance = track.width / 2 + TREE_CLEARANCE_EXTRA;
    /** @type {Placement[]} */
    const candidates = [];

    const push = (x, z, s, seed, row, dist) => {
        candidates.push({ x, z, s, seed, kind: kindFor(look.kind, seed), row, dist });
    };
    const consider = (x, z, s, seed) => {
        const hit = index.nearest(x, z, LOD_DISTANCE + 1);
        if (hit.dist < clearance) {
            return;
        }
        push(x, z, s, seed, hit.index, hit.dist);
    };

    for (let i = 0; i < trees.length; i++) {
        const [x, z, s] = trees[i];
        consider(x, z, s, i);

        // Сгъстяване: OSM дава по едно дърво на площ, а Монца и Спа са тунели
        // от зеленина — всяко дърво получава клонинги, разхвърляни около него.
        const extra = Math.floor(look.treeDensity - 1 + hashNoise(i * 13.7));
        for (let e = 0; e < extra; e++) {
            const angle = hashNoise(i * 17.3 + e * 7.1) * Math.PI * 2;
            const radius = 5 + hashNoise(i * 23.9 + e * 3.3) * 13;
            consider(
                x + Math.cos(angle) * radius,
                z + Math.sin(angle) * radius,
                s * (0.8 + hashNoise(i + e * 41.7) * 0.5),
                i * 31 + e + 1009
            );
        }
    }

    if (look.treeDensity >= FOREST_FILL_MIN_DENSITY && look.kind !== 'shrub' && trees.length > 0) {
        // Грубият растер отсява евтино (едно четене) преди точното търсене;
        // далечната лента го ползва и като окончателна стойност — билбордите
        // не ползват реда, а ±8 m грешка на 150-650 m не се вижда.
        const raster = distanceRaster(track, FOREST_FILL_FAR.to + FOREST_FILL_FAR.spacing);
        const nearFrom = clearance + FOREST_FILL_NEAR.from;
        forestFill(ctx, FOREST_FILL_NEAR, raster, (x, z, s, seed) => {
            const hit = index.nearest(x, z, LOD_DISTANCE + 1);
            if (hit.index >= 0 && hit.dist >= nearFrom) {
                push(x, z, s, seed, hit.index, hit.dist);
            }
        });
        forestFill(ctx, FOREST_FILL_FAR, raster, (x, z, s, seed, dist) => push(x, z, s, seed, -1, dist));
    }

    // Първо отделяме естествения набор. Auto/High минава през старите тавани
    // без допълнително разреждане, което пази досегашната геометрия точно.
    const naturalNear = [];
    const naturalFar = [];
    for (const p of candidates) {
        if (p.dist < LOD_DISTANCE) {
            naturalNear.push(p);
        } else if (p.kind !== 'shrub') {
            naturalFar.push(p);
        }
    }

    if (profile.name === 'lowPower') {
        return capPlacements(naturalNear, naturalFar, profile);
    }

    const baseline = capPlacements(naturalNear, naturalFar, VEGETATION_PROFILES.high);
    if (profile.name === 'high') {
        return { near: baseline.near, far: baseline.far };
    }

    if (profile.name === 'ultra') {
        // +23% 3D дървета чрез детерминирани клонинги в същите kind/row
        // buckets. buildNearForest брои оригиналите при chunk merge, така че
        // повишението не създава допълнителни draw calls.
        const nearTarget = Math.min(profile.near, baseline.near.length + Math.floor(baseline.near.length * 0.23));
        const near = densifyNear(ctx, baseline.near, nearTarget);

        // Ultra може да запази и повече от вече съществуващия billboard pool;
        // това остава същият един InstancedMesh draw call.
        const baseSet = new Set(baseline.near);
        const farPool = [...naturalFar];
        for (const p of naturalNear) {
            if (!baseSet.has(p) && p.kind !== 'shrub') {
                farPool.push(p);
            }
        }
        const far = decimate(farPool, Math.max(0, profile.total - near.length));

        return { near, far };
    }

    // Low/Medium са процент от реално построявания досега High набор, затова
    // намаляват и на редки писти, където само по-нисък абсолютен cap не помага.
    const totalTarget = Math.min(profile.total, Math.floor((baseline.near.length + baseline.far.length) * profile.retain));
    const nearTarget = Math.min(profile.near, totalTarget, Math.floor(baseline.near.length * profile.retain));
    const near = decimate(baseline.near, nearTarget);
    const farTarget = Math.min(baseline.far.length, Math.max(0, totalTarget - near.length));
    const far = decimate(baseline.far, farTarget);

    return { near, far };
}

/**
 * Старото правило за таваните: при near overflow най-далечните стават
 * billboard кандидати, а после целият далечен набор се разрежда равномерно.
 *
 * @param {Placement[]} naturalNear
 * @param {Placement[]} naturalFar
 * @param {{near: number, total: number}} caps
 * @returns {{near: Placement[], far: Placement[]}}
 */
function capPlacements(naturalNear, naturalFar, caps) {
    const near = [...naturalNear];
    let far = [...naturalFar];
    if (near.length > caps.near) {
        near.sort((a, b) => a.dist - b.dist);
        for (const p of near.splice(caps.near)) {
            if (p.kind !== 'shrub') {
                far.push(p);
            }
        }
    }
    far = decimate(far, Math.max(0, caps.total - near.length));

    return { near, far };
}

/**
 * Добавя Ultra детайла навън от трасето и по тангентата. Клонингът запазва
 * row/kind на източника: влиза в същия InstancedMesh chunk и не добавя draw call.
 *
 * @param {object} ctx
 * @param {Placement[]} base
 * @param {number} target
 * @returns {Placement[]}
 */
function densifyNear(ctx, base, target) {
    if (base.length === 0 || target <= base.length) {
        return base;
    }
    const { track } = ctx;
    const out = [...base];
    const extras = target - base.length;

    for (let e = 0; e < extras; e++) {
        // Стъпката разпределя клонингите по цялата писта, вместо да сгъстява
        // началото на масива. При 23% всеки източник се ползва най-много веднъж.
        const source = base[Math.floor((e + 0.5) * base.length / extras) % base.length];
        const row = Math.max(0, source.row);
        const seed = 900001 + source.seed * 37 + e * 101;
        const along = (hashNoise(seed * 1.31) - 0.5) * 8;
        const outward = 1.5 + hashNoise(seed * 1.73) * 2.5;
        const side = ((source.x - track.xs[row]) * track.nx[row] + (source.z - track.zs[row]) * track.nz[row]) >= 0 ? 1 : -1;

        out.push({
            x: source.x + track.tx[row] * along + track.nx[row] * outward * side,
            z: source.z + track.tz[row] * along + track.nz[row] * outward * side,
            s: source.s * (0.9 + hashNoise(seed * 2.17) * 0.2),
            seed,
            kind: source.kind,
            row: source.row,
            dist: source.dist + outward,
            qualityClone: true,
        });
    }

    return out;
}

/**
 * Запълване на гората в лента около оста: трептяща решетка, маска от шум
 * (поляни остават), без ориентирите и без стартовата права (пит комплекс,
 * трибуни, решетка — там decor строи своето). Проверките са по цена:
 * растер → шум → старт/ориентири → accept (точното търсене е в него).
 *
 * @param {object} ctx
 * @param {{from: number, to: number, spacing: number, threshold: number}} band
 * @param {{at: (x: number, z: number) => number}} raster
 * @param {(x: number, z: number, s: number, seed: number, dist: number) => void} accept
 */
function forestFill(ctx, band, raster, accept) {
    const { index, track, startStraight, rings } = ctx;
    const reach = band.to + band.spacing;
    const x0 = index.minX - reach;
    const x1 = index.maxX + reach;
    const z0 = index.minZ - reach;
    const z1 = index.maxZ + reach;
    // Растерът греши до ~8 %: пускаме малко по-широко, точното е в accept.
    const rasterFrom = band.from * 0.9;
    const rasterTo = band.to * 1.08;
    // Стартовата права е затворена за запълване до FOREST_FILL_START_CLEAR m.
    const startFrom = track.count - startStraight.back;
    const startTo = startStraight.forward;
    const nearStart = (x, z) => {
        const hit = index.nearest(x, z, FOREST_FILL_START_CLEAR);
        return hit.index >= 0 && (hit.index <= startTo || hit.index >= startFrom);
    };
    let n = 0;

    for (let z = z0; z <= z1; z += band.spacing) {
        for (let x = x0; x <= x1; x += band.spacing, n++) {
            const seed = 50000 + Math.round(band.spacing) * 100000 + n;
            const px = x + (hashNoise(seed * 1.7) - 0.5) * band.spacing * 0.8;
            const pz = z + (hashNoise(seed * 2.3) - 0.5) * band.spacing * 0.8;
            const dist = raster.at(px, pz);
            if (dist < rasterFrom || dist > rasterTo) {
                continue;
            }
            if (fbm2((px + 3000) / 180, (pz - 3000) / 180) < band.threshold) {
                continue;
            }
            if ((dist < FOREST_FILL_START_CLEAR * 1.1 && nearStart(px, pz)) || insideAnyRing(rings, px, pz)) {
                continue;
            }
            accept(px, pz, 0.85 + hashNoise(seed * 3.1) * 0.4, seed, Math.min(band.to, Math.max(band.from, dist)));
        }
    }
}

/**
 * Груб растер на разстоянието до осевата линия (клетки по 16 m, chamfer
 * трансформация в два прохода, грешка ≤ ~8 %). За далечното запълване,
 * където точна стойност не трябва.
 *
 * @param {import('./track.js').Track} track
 * @param {number} margin Колко навън от bbox-а на трасето покрива
 * @returns {{at: (x: number, z: number) => number}}
 */
function distanceRaster(track, margin) {
    const { xs, zs, count } = track;
    const cell = 16;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
        minX = Math.min(minX, xs[i]);
        maxX = Math.max(maxX, xs[i]);
        minZ = Math.min(minZ, zs[i]);
        maxZ = Math.max(maxZ, zs[i]);
    }
    const x0 = minX - margin;
    const z0 = minZ - margin;
    const cols = Math.ceil((maxX - minX + margin * 2) / cell) + 1;
    const rows = Math.ceil((maxZ - minZ + margin * 2) / cell) + 1;
    const dist = new Float32Array(cols * rows).fill(Infinity);

    for (let i = 0; i < count; i++) {
        const cx = Math.floor((xs[i] - x0) / cell);
        const cz = Math.floor((zs[i] - z0) / cell);
        dist[cz * cols + cx] = 0;
    }

    const DIAG = Math.SQRT2;
    const at = (cx, cz) => (cx < 0 || cz < 0 || cx >= cols || cz >= rows ? Infinity : dist[cz * cols + cx]);
    for (let cz = 0; cz < rows; cz++) {
        for (let cx = 0; cx < cols; cx++) {
            const k = cz * cols + cx;
            dist[k] = Math.min(
                dist[k],
                at(cx - 1, cz) + 1,
                at(cx, cz - 1) + 1,
                at(cx - 1, cz - 1) + DIAG,
                at(cx + 1, cz - 1) + DIAG
            );
        }
    }
    for (let cz = rows - 1; cz >= 0; cz--) {
        for (let cx = cols - 1; cx >= 0; cx--) {
            const k = cz * cols + cx;
            dist[k] = Math.min(
                dist[k],
                at(cx + 1, cz) + 1,
                at(cx, cz + 1) + 1,
                at(cx + 1, cz + 1) + DIAG,
                at(cx - 1, cz + 1) + DIAG
            );
        }
    }

    return {
        at(x, z) {
            return at(Math.floor((x - x0) / cell), Math.floor((z - z0) / cell)) * cell;
        },
    };
}

/**
 * Правата на старт/финала — същото правило като decor.findStartStraight
 * (дублирано: decor не го експортира, а зависимост към него е излишна).
 *
 * @param {import('./track.js').Track} track
 * @returns {{back: number, forward: number}} Редове назад/напред от S/F
 */
function findStartStraight(track) {
    const { curvature, count } = track;
    const limit = Math.min(180, Math.floor(count / 3));

    let back = 0;
    while (back < limit && Math.abs(curvature[(((-back - 1) % count) + count) % count]) < 0.006) {
        back++;
    }
    let forward = 0;
    while (forward < limit && Math.abs(curvature[(forward + 1) % count]) < 0.006) {
        forward++;
    }

    return { back, forward };
}

/**
 * Контурите на OSM трибуните и сградите с bounding box за бърз отказ.
 *
 * @param {import('./track.js').Track} track
 * @returns {Array<{ring: Array<Array<number>>, minX: number, maxX: number, minZ: number, maxZ: number}>}
 */
function landmarkRings(track) {
    const rings = [...(track.landmarks?.grandstands ?? []), ...(track.landmarks?.buildings ?? [])];

    return rings
        .filter((ring) => ring.length >= 3)
        .map((ring) => {
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
            return { ring, minX, maxX, minZ, maxZ };
        });
}

/**
 * Точка в контур (even-odd), с 2 m буфер през bounding box-а.
 *
 * @param {ReturnType<typeof landmarkRings>} rings
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
function insideAnyRing(rings, x, z) {
    for (const entry of rings) {
        if (x < entry.minX - 2 || x > entry.maxX + 2 || z < entry.minZ - 2 || z > entry.maxZ + 2) {
            continue;
        }
        const ring = entry.ring;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, zi] = ring[i];
            const [xj, zj] = ring[j];
            if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
                inside = !inside;
            }
        }
        if (inside) {
            return true;
        }
    }

    return false;
}

/**
 * @param {'deciduous'|'conifer'|'mixed'|'shrub'} kind
 * @param {number} seed
 * @returns {'deciduous'|'conifer'|'shrub'}
 */
function kindFor(kind, seed) {
    if (kind === 'mixed') {
        return hashNoise(seed * 7.91) > 0.45 ? 'deciduous' : 'conifer';
    }

    return kind;
}

// ── Близка гора (3D) ─────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {Placement[]} placements
 * @returns {THREE.InstancedMesh[]}
 */
function buildNearForest(ctx, placements) {
    if (placements.length === 0) {
        return [];
    }
    const { track, look, lowPower } = ctx;
    const rowsPerChunk = Math.max(1, Math.round(NEAR_CHUNK_METRES / track.spacing));

    // Парчета по вид и по участък от трасето; дребните се сливат с предишното.
    /** @type {Map<string, Map<number, Placement[]>>} */
    const byKind = new Map();
    for (const p of placements) {
        let chunks = byKind.get(p.kind);
        if (!chunks) {
            chunks = new Map();
            byKind.set(p.kind, chunks);
        }
        const id = Math.floor(p.row / rowsPerChunk);
        let list = chunks.get(id);
        if (!list) {
            list = [];
            chunks.set(id, list);
        }
        list.push(p);
    }

    const canopy = createCanopyTexture(ctx.maxAniso);
    const material = litMaterial(lowPower, {
        map: canopy,
        vertexColors: true,
        roughness: 0.95,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
    });
    material.alphaToCoverage = lowPower;
    windPatch(ctx, material, 'tree');
    patchCanopyNormals(material);
    ctx.disposables.push(material, canopy);

    // The shadow uses the same cutout and wind as the visible leaf clusters.
    // Keep one shared depth material, just as with the former solid crowns.
    const depth = lowPower ? null : depthMaterialFor(ctx, 'tree');
    if (depth) {
        depth.map = canopy;
        depth.alphaTest = material.alphaTest;
        depth.side = THREE.DoubleSide;
    }

    const meshes = [];
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const base = new THREE.Color(look.foliage);
    const tint = new THREE.Color();

    for (const [kind, chunks] of byKind) {
        const geometry = createTreeGeometry(kind, look.foliage, lowPower);
        ctx.disposables.push(geometry);

        const ordered = [...chunks.keys()].sort((a, b) => a - b);
        const merged = [];
        const originalCount = (list) => {
            let count = 0;
            for (const placement of list) {
                if (!placement.qualityClone) {
                    count++;
                }
            }
            return count;
        };
        for (const id of ordered) {
            const list = chunks.get(id);
            const previous = merged[merged.length - 1];
            // Ultra клонингите не променят решението за chunk merge: High и
            // Ultra имат еднакъв брой InstancedMesh draw calls.
            if (previous && (originalCount(list) < NEAR_CHUNK_MIN || originalCount(previous) < NEAR_CHUNK_MIN)) {
                previous.push(...list);
            } else {
                merged.push(list);
            }
        }

        for (const list of merged) {
            const mesh = new THREE.InstancedMesh(geometry, material, list.length);
            mesh.name = `forest-${kind}`;
            for (let n = 0; n < list.length; n++) {
                const p = list[n];
                const s = p.s * look.treeScale;
                position.set(p.x, ctx.heightAt(p.x, p.z) - 0.25, p.z);
                quaternion.setFromAxisAngle(UP, hashNoise(p.seed) * Math.PI * 2);
                scale.set(s, s * (0.85 + hashNoise(p.seed * 3) * 0.4), s);
                matrix.compose(position, quaternion, scale);
                mesh.setMatrixAt(n, matrix);
                mesh.setColorAt(n, jitterMultiplier(base, p.seed, tint));
            }
            finishInstanced(mesh);
            mesh.castShadow = !lowPower;
            mesh.receiveShadow = true;
            if (!lowPower) {
                mesh.customDepthMaterial = depth;
            }
            meshes.push(mesh);
        }
    }

    return meshes;
}

/**
 * Вертексни цветове: цвят × (1 − gradient) в основата на частта → цвят на
 * върха ѝ, плюс ±4 % шум по връх.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number} color
 * @param {number} gradient 0..1 колко по-тъмна е основата
 */
function paintGradient(geometry, color, gradient) {
    const positions = geometry.attributes.position;
    const count = positions.count;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let v = 0; v < count; v++) {
        const y = positions.getY(v);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    const span = Math.max(1e-3, maxY - minY);
    const c = new THREE.Color(color);
    const colors = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
        const t = (positions.getY(v) - minY) / span;
        const shade = (1 - gradient) + gradient * t * t * (3 - 2 * t) + (hashNoise(v * 0.731 + 11) - 0.5) * 0.08;
        colors[v * 3] = clamp01(c.r * shade);
        colors[v * 3 + 1] = clamp01(c.g * shade);
        colors[v * 3 + 2] = clamp01(c.b * shade);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// ── Далечна гора (билборди) ──────────────────────────────────────────────

/**
 * Кръстосани квадрати с процедурен атлас (4 силуета × 2 вида); per-instance
 * избор на силует през атрибут aAtlas и кръпка на uv-то. Нормалата се
 * подменя във фрагмента с „нагоре + към камерата": иначе DoubleSide обръща
 * нормалата на задната плоскост и половината билборди са черни.
 *
 * @param {object} ctx
 * @param {Placement[]} placements
 * @returns {THREE.InstancedMesh|null}
 */
function buildBillboards(ctx, placements) {
    if (placements.length === 0) {
        return null;
    }
    const { look, lowPower } = ctx;

    const atlas = makeTreeAtlas(look.foliage, ctx.maxAniso);
    const geometry = crossedQuads(1, 1);
    const atlasAttr = new THREE.InstancedBufferAttribute(new Float32Array(placements.length * 2), 2);
    geometry.setAttribute('aAtlas', atlasAttr);
    ctx.disposables.push(geometry);

    const material = litMaterial(lowPower, {
        map: atlas,
        alphaTest: atlas ? 0.4 : 0,
        side: THREE.DoubleSide,
        roughness: 1,
    });
    // MSAA на телефона: alpha-to-coverage омекотява ръба на alphaTest.
    material.alphaToCoverage = lowPower;
    windPatch(ctx, material, 'billboard');
    applyPatch(material, {
        name: 'tree-atlas',
        uniforms: { uAtlasScale: { value: new THREE.Vector2(0.25, 0.5) } },
        vertexHead: 'attribute vec2 aAtlas;\nuniform vec2 uAtlasScale;',
        replace: [
            ['uv_vertex', '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = vMapUv * uAtlasScale + aAtlas;\n#endif'],
        ],
    });
    upNormalPatch(material);
    ctx.disposables.push(material);
    if (atlas) {
        ctx.disposables.push(atlas);
    }

    const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
    mesh.name = 'forest-billboards';
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const base = new THREE.Color(look.foliage);
    const tint = new THREE.Color();

    for (let n = 0; n < placements.length; n++) {
        const p = placements[n];
        const height = TREE_HEIGHT[p.kind] * p.s * look.treeScale * (0.85 + hashNoise(p.seed * 3) * 0.4);
        position.set(p.x, ctx.heightAt(p.x, p.z) - 0.2, p.z);
        quaternion.setFromAxisAngle(UP, hashNoise(p.seed) * Math.PI);
        scale.set(height, height, height);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(n, matrix);
        mesh.setColorAt(n, jitterMultiplier(base, p.seed, tint));
        atlasAttr.setXY(n, Math.floor(hashNoise(p.seed * 5.3) * 4) * 0.25, p.kind === 'conifer' ? 0.5 : 0);
    }

    finishInstanced(mesh);
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    return mesh;
}

/**
 * Атлас 512×256: ред 0 (долу, v∈[0,0.5]) широколистни, ред 1 иглолистни, по
 * 4 силуета в ред, всеки в клетка 128×128 със стъблото в долния ръб.
 * Canvas текстура — three не носи готови изображения, а бинарни активи не
 * добавяме. В Node (без document) връща null и билбордите са плътен цвят.
 *
 * @param {number} foliage
 * @param {number} maxAniso
 * @returns {THREE.CanvasTexture|null}
 */
function makeTreeAtlas(foliage, maxAniso) {
    if (typeof document === 'undefined') {
        return null;
    }
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size * 4;
    canvas.height = size * 2;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const base = new THREE.Color(foliage);
    const shade = (k) => `#${base.clone().multiplyScalar(k).getHexString()}`;
    const trunk = `#${new THREE.Color(COLORS.trunk).getHexString()}`;

    for (let col = 0; col < 4; col++) {
        const x0 = col * size;
        // Ред 0 е долната половина на канваса (flipY: v=0 е долу).
        const deciduousY = size;
        const coniferY = 0;

        // Широколистно: ствол + купчина припокрити кръгове, светли отгоре.
        ctx.fillStyle = trunk;
        ctx.fillRect(x0 + size / 2 - 5, deciduousY + size * 0.55, 10, size * 0.45);
        const blobs = 5 + Math.floor(hashNoise(col * 3.1) * 3);
        for (let b = 0; b < blobs; b++) {
            const bx = x0 + size * (0.3 + hashNoise(col * 7.3 + b) * 0.4);
            const by = deciduousY + size * (0.22 + hashNoise(col * 9.1 + b * 2) * 0.35);
            const r = size * (0.16 + hashNoise(col * 4.7 + b * 3) * 0.12);
            const grad = ctx.createRadialGradient(bx - r * 0.35, by - r * 0.4, r * 0.1, bx, by, r);
            grad.addColorStop(0, shade(1.18));
            grad.addColorStop(0.7, shade(0.92));
            grad.addColorStop(1, shade(0.62));
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(bx, by, r, 0, Math.PI * 2);
            ctx.fill();
        }

        // Иглолистно: ствол + 4 наслагани триъгълника, осветени отляво.
        ctx.fillStyle = trunk;
        ctx.fillRect(x0 + size / 2 - 4, coniferY + size * 0.75, 8, size * 0.25);
        const tiers = 4;
        for (let t = 0; t < tiers; t++) {
            const top = coniferY + size * (0.04 + t * 0.2);
            const bottom = coniferY + size * (0.34 + t * 0.2);
            const half = size * (0.14 + t * 0.09) * (0.9 + hashNoise(col * 5.9 + t) * 0.2);
            const cx = x0 + size / 2;
            const grad = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
            grad.addColorStop(0, shade(1.08));
            grad.addColorStop(0.5, shade(0.85));
            grad.addColorStop(1, shade(0.55));
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(cx, top);
            ctx.lineTo(cx + half, bottom);
            ctx.lineTo(cx - half, bottom);
            ctx.closePath();
            ctx.fill();
        }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAniso;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    return texture;
}

/**
 * Две вертикални плоскости под 90°, основа в y=0, uv 0..1.
 *
 * @param {number} width
 * @param {number} height
 * @returns {THREE.BufferGeometry}
 */
function crossedQuads(width, height) {
    const a = new THREE.PlaneGeometry(width, height);
    a.translate(0, height / 2, 0);
    const b = a.clone();
    b.rotateY(Math.PI / 2);
    const merged = mergeGeometries([a, b], false);
    a.dispose();
    b.dispose();
    merged.computeBoundingSphere();

    return merged;
}

// ── Банкет: туфи и храсти ────────────────────────────────────────────────

/**
 * Туфи по 1 на 3 m от двете страни между half+1.5 и half+6, храсти по 1 на
 * 25 m на half+7..+9. Пропускат се чакълените/асфалтовите run-off зони (там
 * трева няма) и пит комплексът. При пясък: без туфи, редки сухи храсти.
 *
 * @param {object} ctx
 * @param {{from: number, to: number, sign: number}|null} pitRange
 * @returns {{tufts: THREE.InstancedMesh|null, bushes: THREE.InstancedMesh|null}}
 */
function buildVergeDetail(ctx, pitRange) {
    const { track, look, profile, lowPower } = ctx;
    const { xs, zs, tx, tz, nx, nz, count, spacing, halfWidths } = track;
    const sand = look.terrainKind === 'sand';

    const blocked = blockedSides(ctx, pitRange);

    /** @type {Array<{x: number, z: number, y: number, s: number, seed: number}>} */
    const tuftSpots = [];
    /** @type {Array<{x: number, z: number, y: number, s: number, seed: number}>} */
    const bushSpots = [];

    const bushStep = Math.max(1, Math.round((sand ? 60 : 25) / spacing));
    const tuftsPerRow = spacing / 3;

    const place = (list, i, side, along, lateral, s, seed) => {
        const offset = side * lateral;
        const x = xs[i] + tx[i] * along + nx[i] * offset;
        const z = zs[i] + tz[i] * along + nz[i] * offset;
        let y = ctx.groundY(i, offset);
        if (lateral > RIBBON.width) {
            // Отвъд лентата стъпваме на по-ниското от лентата и терена:
            // потънал храст не се вижда, увиснал — да.
            y = Math.min(y, ctx.heightAt(x, z));
        }
        list.push({ x, z, y, s, seed });
    };

    for (let i = 0; i < count; i++) {
        for (let side = -1; side <= 1; side += 2) {
            if (blocked[i] & (side > 0 ? 1 : 2)) {
                continue;
            }
            const half = halfWidths[i];
            const sideSeed = i * 2 + (side > 0 ? 1 : 0);

            if (!sand && (look.terrainKind !== 'mixed' || hashNoise(sideSeed * 0.91) < 0.5)) {
                const n = Math.floor(tuftsPerRow + hashNoise(sideSeed * 1.13));
                for (let k = 0; k < n; k++) {
                    const seed = sideSeed * 17 + k * 101;
                    place(
                        tuftSpots,
                        i,
                        side,
                        (hashNoise(seed * 1.7) - 0.5) * spacing,
                        half + 1.5 + hashNoise(seed * 2.9) * 4.5,
                        0.7 + hashNoise(seed * 3.7) * 0.6,
                        seed
                    );
                }
            }

            if ((i + (side > 0 ? 0 : Math.floor(bushStep / 2))) % bushStep === 0 && hashNoise(sideSeed * 4.3) < 0.85) {
                const seed = sideSeed * 23 + 7;
                place(
                    bushSpots,
                    i,
                    side,
                    (hashNoise(seed * 1.3) - 0.5) * spacing,
                    half + 7 + hashNoise(seed * 2.1) * 2,
                    0.7 + hashNoise(seed * 3.3) * 0.7,
                    seed
                );
            }
        }
    }

    const tufts = profiledVergeSpots(tuftSpots, profile, 'tufts');
    const bushes = profiledVergeSpots(bushSpots, profile, 'bushes');

    return {
        tufts: tufts.length > 0 ? buildTufts(ctx, tufts) : null,
        bushes: bushes.length > 0 ? buildBushes(ctx, bushes, sand, lowPower) : null,
    };
}

/**
 * Low/Medium се изчисляват спрямо досегашния High набор, за да намаляват
 * детайла и когато абсолютният cap не е достигнат. Ultra използва до 20%
 * повече вече генерирани кандидати. lowPower пази старите си тавани.
 *
 * @template T
 * @param {T[]} spots
 * @param {object} profile
 * @param {'tufts'|'bushes'} key
 * @returns {T[]}
 */
function profiledVergeSpots(spots, profile, key) {
    if (profile.name === 'lowPower') {
        return decimate(spots, profile[key]);
    }

    const baseline = decimate(spots, VEGETATION_PROFILES.high[key]);
    if (profile.name === 'high') {
        return baseline;
    }
    if (profile.name === 'ultra') {
        const target = Math.min(profile[key], spots.length, Math.floor(baseline.length * profile.verge));
        return decimate(spots, target);
    }

    const target = Math.min(profile[key], Math.floor(baseline.length * profile.verge));
    return decimate(baseline, target);
}

/**
 * Битова маска по ред: 1 = дясната страна е заета (run-off/пит), 2 = лявата.
 * Run-off зоните са същите като decor.buildRunoffZones (sim.runoffRanges;
 * out = -side), пит комплексът — редовете на decor.buildPitComplex.
 *
 * @param {object} ctx
 * @param {{from: number, to: number, sign: number}|null} pitRange  От decor (pitRange); иначе се извежда
 * @returns {Uint8Array}
 */
function blockedSides(ctx, pitRange) {
    const { track, circuit, startStraight } = ctx;
    const { count } = track;
    const blocked = new Uint8Array(count);
    const mark = (from, to, sign) => {
        const bit = sign > 0 ? 1 : 2;
        for (let r = from; r <= to; r++) {
            blocked[((r % count) + count) % count] |= bit;
        }
    };

    if (circuit.runoff !== 'none') {
        for (const range of runoffRanges(track)) {
            mark(range.from, range.to, -range.side);
        }
    }

    // Пит комплексът: decor го строи от -back+3 до forward-3 на pitSide.
    const pit = pitRange ?? {
        from: -startStraight.back + 3,
        to: startStraight.forward - 3,
        sign: circuit.pitSide === 'left' ? -1 : 1,
    };
    if (pit.to > pit.from) {
        mark(pit.from, pit.to, pit.sign);
    }

    return blocked;
}

/**
 * Равномерно разреждане до таван (не отрязване — иначе краят на пистата
 * остава гол).
 *
 * @template T
 * @param {T[]} list
 * @param {number} cap
 * @returns {T[]}
 */
function decimate(list, cap) {
    if (list.length <= cap) {
        return list;
    }
    const keep = cap / list.length;
    const out = [];
    let acc = 0;
    for (const item of list) {
        acc += keep;
        if (acc >= 1) {
            acc -= 1;
            out.push(item);
        }
    }

    return out;
}

/**
 * @param {object} ctx
 * @param {Array<{x: number, z: number, y: number, s: number, seed: number}>} spots
 * @returns {THREE.InstancedMesh}
 */
function buildTufts(ctx, spots) {
    const { look, lowPower } = ctx;
    const texture = makeTuftTexture();
    const geometry = crossedQuads(0.6, 0.55);
    ctx.disposables.push(geometry);

    const material = litMaterial(lowPower, {
        map: texture,
        alphaTest: texture ? 0.4 : 0,
        side: THREE.DoubleSide,
        roughness: 1,
    });
    material.alphaToCoverage = lowPower;
    windPatch(ctx, material, 'tuft');
    upNormalPatch(material);
    ctx.disposables.push(material);
    if (texture) {
        ctx.disposables.push(texture);
    }

    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    mesh.name = 'verge-tufts';
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    // Цветът е абсолютен (картата е сива): тревата на банкета е PBR текстура
    // × grassTint, туфата приближава същия тон.
    const base = new THREE.Color(COLORS.tuft).multiply(new THREE.Color(look.grassTint));
    const tint = new THREE.Color();

    for (let n = 0; n < spots.length; n++) {
        const p = spots[n];
        // Леко потънала — основата на картата е мека и не бива да „виси".
        position.set(p.x, p.y - 0.06, p.z);
        quaternion.setFromAxisAngle(UP, hashNoise(p.seed * 0.7) * Math.PI);
        scale.set(p.s, p.s * (0.8 + hashNoise(p.seed * 1.9) * 0.5), p.s);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(n, matrix);
        mesh.setColorAt(n, jitterColor(base, p.seed, tint));
    }

    finishInstanced(mesh);
    mesh.castShadow = false;
    mesh.receiveShadow = true;

    return mesh;
}

/**
 * Снопче стръкове върху прозрачен фон: сиво с вертикален градиент (по-тъмно в
 * основата), цветът идва от instanceColor. Стръковете са 5-7 px на 64 px —
 * по-тънки изчезват след два mip нива под alphaTest.
 *
 * @returns {THREE.CanvasTexture|null}
 */
function makeTuftTexture() {
    if (typeof document === 'undefined') {
        return null;
    }
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.lineCap = 'round';

    const blades = 9;
    for (let b = 0; b < blades; b++) {
        const t = (b + 0.5) / blades;
        const x0 = size * (0.42 + (t - 0.5) * 0.3);
        const lean = (t - 0.5) * size * 0.9 + (hashNoise(b * 3.3) - 0.5) * 10;
        const top = size * (0.05 + hashNoise(b * 5.1) * 0.25);
        const grad = ctx.createLinearGradient(0, size, 0, top);
        grad.addColorStop(0, 'rgba(92, 92, 92, 1)');
        grad.addColorStop(1, 'rgba(230, 230, 230, 1)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 5 + hashNoise(b * 7.7) * 2;
        ctx.beginPath();
        ctx.moveTo(x0, size);
        ctx.quadraticCurveTo(x0 + lean * 0.3, size * 0.55, x0 + lean, top);
        ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    return texture;
}

/**
 * @param {object} ctx
 * @param {Array<{x: number, z: number, y: number, s: number, seed: number}>} spots
 * @param {boolean} dry Сухи (пясъчен терен) — друг цвят, по-сплескани
 * @param {boolean} lowPower
 * @returns {THREE.InstancedMesh}
 */
function buildBushes(ctx, spots, dry, lowPower) {
    const colour = dry ? COLORS.dryBush : ctx.look.foliage;
    const geometry = new THREE.IcosahedronGeometry(1.1, 1);
    geometry.scale(1, dry ? 0.55 : 0.7, 1);
    geometry.translate(0, dry ? 0.45 : 0.6, 0);
    paintGradient(geometry, colour, 0.4);
    geometry.computeBoundingSphere();
    ctx.disposables.push(geometry);

    const material = litMaterial(lowPower, { vertexColors: true, roughness: 0.95 });
    windPatch(ctx, material, 'bush');
    ctx.disposables.push(material);

    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    mesh.name = 'verge-bushes';
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const base = new THREE.Color(colour);
    const tint = new THREE.Color();

    for (let n = 0; n < spots.length; n++) {
        const p = spots[n];
        position.set(p.x, p.y - 0.1, p.z);
        quaternion.setFromAxisAngle(UP, hashNoise(p.seed * 0.7) * Math.PI * 2);
        scale.set(p.s * (0.9 + hashNoise(p.seed * 1.1) * 0.4), p.s, p.s);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(n, matrix);
        mesh.setColorAt(n, jitterMultiplier(base, p.seed, tint));
    }

    finishInstanced(mesh);
    mesh.castShadow = !lowPower;
    mesh.receiveShadow = true;
    if (!lowPower) {
        mesh.customDepthMaterial = depthMaterialFor(ctx, 'bush');
    }

    return mesh;
}

// ── Птици ────────────────────────────────────────────────────────────────

/**
 * Ято от 16 шеврона: махат с крила във vertex шейдъра (aWing × sin по
 * gl_InstanceID), летят по Лисажу около котва до трасето. Котвата се
 * пренася ~350 m пред колата, щом ятото остане далеч зад нея (извън мъглата,
 * невидимо) — иначе при Спа птици над центроида никой не вижда.
 *
 * @param {object} ctx
 * @returns {{mesh: THREE.InstancedMesh, update: (dt: number, camera: THREE.Camera, time: number) => void}}
 */
function buildBirdFlock(ctx) {
    const { track } = ctx;
    const { xs, zs, nx, nz, count, spacing } = track;

    const geometry = birdGeometry();
    ctx.disposables.push(geometry);
    const material = new THREE.MeshBasicMaterial({ color: COLORS.bird, side: THREE.DoubleSide });
    applyPatch(material, {
        name: 'bird-flap',
        uniforms: { uWindTime: ctx.uniforms.uWindTime },
        vertexHead: 'attribute float aWing;\nuniform float uWindTime;',
        replace: [
            [
                'begin_vertex',
                '#include <begin_vertex>\n\ttransformed.y += aWing * sin(uWindTime * 9.0 + float(gl_InstanceID) * 1.3) * 0.22;',
            ],
        ],
    });
    ctx.disposables.push(material);

    const mesh = new THREE.InstancedMesh(geometry, material, BIRD_COUNT);
    mesh.name = 'birds';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 45);

    const identity = new THREE.Matrix4();
    for (let i = 0; i < BIRD_COUNT; i++) {
        mesh.setMatrixAt(i, identity);
    }

    const state = {
        t: hashNoise(hashString(track.slug) * 1e-4) * 100,
        anchored: false,
        anchorX: 0,
        anchorY: 0,
        anchorZ: 0,
        side: 1,
        scanTimer: 1,
        centre: new THREE.Vector3(),
        previous: new THREE.Vector3(),
        heading: 0,
    };
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const aheadRows = Math.round(350 / spacing);

    const reanchor = (camera) => {
        let best = 0;
        let bestSq = Infinity;
        for (let i = 0; i < count; i += 3) {
            const dx = camera.position.x - xs[i];
            const dz = camera.position.z - zs[i];
            const d = dx * dx + dz * dz;
            if (d < bestSq) {
                bestSq = d;
                best = i;
            }
        }
        const a = (best + aheadRows) % count;
        state.side = -state.side;
        const lateral = state.side * (90 + hashNoise(a * 0.37) * 50);
        state.anchorX = xs[a] + nx[a] * lateral;
        state.anchorZ = zs[a] + nz[a] * lateral;
        state.anchorY = ctx.heightAt(state.anchorX, state.anchorZ);
        state.anchored = true;
    };

    const update = (dt, camera, time) => {
        state.scanTimer += dt;
        if (!state.anchored || state.scanTimer > 0.5) {
            state.scanTimer = 0;
            const dx = camera.position.x - state.centre.x;
            const dz = camera.position.z - state.centre.z;
            if (!state.anchored || dx * dx + dz * dz > 650 * 650) {
                reanchor(camera);
            }
        }
        state.t += dt;
        const t = state.t;

        state.previous.copy(state.centre);
        state.centre.set(
            state.anchorX + Math.sin(t * 0.11) * 90,
            state.anchorY + 55 + Math.sin(t * 0.05) * 8,
            state.anchorZ + Math.sin(t * 0.07 + 1.3) * 70
        );
        const vx = state.centre.x - state.previous.x;
        const vz = state.centre.z - state.previous.z;
        if (vx * vx + vz * vz > 1e-6) {
            state.heading = Math.atan2(vx, vz);
        }
        const cosH = Math.cos(state.heading);
        const sinH = Math.sin(state.heading);

        for (let i = 0; i < BIRD_COUNT; i++) {
            // Хлабав клин зад водача: странично ±11 m, назад до 18 m, леко
            // дишане на формацията.
            const lateral = (hashNoise(i * 1.7) - 0.5) * 22 + Math.sin(time * 0.6 + i) * 1.5;
            const back = hashNoise(i * 2.9) * 18 + Math.sin(time * 0.4 + i * 0.7) * 2;
            const lift = (hashNoise(i * 3.7) - 0.5) * 8 + Math.sin(time * 0.9 + i) * 1.5;
            position.set(
                state.centre.x + cosH * lateral - sinH * back,
                state.centre.y + lift,
                state.centre.z - sinH * lateral - cosH * back
            );
            quaternion.setFromAxisAngle(UP, state.heading + (hashNoise(i * 4.1) - 0.5) * 0.3);
            matrix.compose(position, quaternion, scale);
            mesh.setMatrixAt(i, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.boundingSphere.center.copy(state.centre);
    };

    return { mesh, update };
}

/**
 * Шеврон: две крила от по един триъгълник, aWing = 1 на върховете на
 * крилата (те махат), 0 на тялото. Размах 1.8 m — едра птица, видима от 100 m.
 *
 * @returns {THREE.BufferGeometry}
 */
function birdGeometry() {
    const positions = new Float32Array([
        // ляво крило: връх, предница на тялото, задница
        -0.9, 0, -0.25, 0, 0, 0.35, 0, 0, -0.15,
        // дясно крило
        0.9, 0, -0.25, 0, 0, -0.15, 0, 0, 0.35,
    ]);
    const wing = new Float32Array([1, 0, 0, 1, 0, 0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aWing', new THREE.BufferAttribute(wing, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    return geometry;
}

// ── Материали и кръпки ───────────────────────────────────────────────────

/**
 * Standard на десктоп, Lambert на телефон (наполовина по-евтин фрагмент при
 * хиляди инстанции; разликата в блясъка на листа не се вижда).
 *
 * @param {boolean} lowPower
 * @param {object} params
 * @returns {THREE.MeshStandardMaterial|THREE.MeshLambertMaterial}
 */
function litMaterial(lowPower, params) {
    if (lowPower) {
        const { roughness, ...rest } = params;
        return new THREE.MeshLambertMaterial(rest);
    }

    return new THREE.MeshStandardMaterial({ metalness: 0, ...params });
}

/**
 * Вятър във vertex шейдъра. Фазата идва от световната позиция на
 * инстанцията (колона 3 на instanceMatrix), така че съседни дървета не
 * махат в такт. Посоката е световна; завъртаме я в локалното пространство
 * през транспонираната ротация (yaw + мащаб), иначе всяко дърво се люлее по
 * своя yaw. Делим на мащаба веднъж, за да остане отместването ∝ размера.
 *
 * @param {object} ctx
 * @param {THREE.Material} material
 * @param {keyof typeof WIND_PROFILES} profile
 */
function windPatch(ctx, material, profile) {
    const { y0, y1, amp } = WIND_PROFILES[profile];
    applyPatch(material, {
        name: 'wind',
        uniforms: ctx.uniforms,
        defines: { WIND_Y0: y0.toFixed(3), WIND_Y1: y1.toFixed(3), WIND_AMP: amp.toFixed(3) },
        vertexHead: 'uniform float uWindTime;\nuniform vec2 uWindDir;',
        replace: [
            [
                'begin_vertex',
                [
                    '#include <begin_vertex>',
                    '{',
                    '#ifdef USE_INSTANCING',
                    '\tvec2 windAnchor = instanceMatrix[3].xz;',
                    '\tvec3 windLocal = transpose(mat3(instanceMatrix)) * vec3(uWindDir.x, 0.0, uWindDir.y);',
                    '\twindLocal *= inversesqrt(max(1e-6, dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz)));',
                    '#else',
                    '\tvec2 windAnchor = vec2(0.0);',
                    '\tvec3 windLocal = vec3(uWindDir.x, 0.0, uWindDir.y);',
                    '#endif',
                    '\tfloat windPhase = dot(windAnchor, vec2(0.37, 0.71));',
                    '\tfloat windSway = sin(uWindTime * 1.4 + windPhase) * 0.35 + sin(uWindTime * 2.9 + windPhase * 1.7) * 0.12;',
                    '\tfloat windWeight = smoothstep(float(WIND_Y0), float(WIND_Y1), position.y);',
                    '\ttransformed += windLocal * (windSway * windWeight * windWeight * float(WIND_AMP));',
                    '}',
                ].join('\n'),
            ],
        ],
    });
}

/**
 * Depth материал със същата вятърна кръпка — иначе сянката стои, а короната
 * се люлее. Един на профил (споделен между парчетата на гората).
 *
 * @param {object} ctx
 * @param {keyof typeof WIND_PROFILES} profile
 * @returns {THREE.MeshDepthMaterial}
 */
function depthMaterialFor(ctx, profile) {
    let material = ctx.depthMaterials.get(profile);
    if (!material) {
        material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
        windPatch(ctx, material, profile);
        ctx.depthMaterials.set(profile, material);
    }

    return material;
}

/**
 * Билборд/туфа: нормала „нагоре + малко към камерата" (в view space), за да
 * се осветяват като земята под тях, без тъмна задна плоскост от DoubleSide.
 *
 * @param {THREE.Material} material
 */
function upNormalPatch(material) {
    applyPatch(material, {
        name: 'up-normal',
        replace: [
            [
                'normal_fragment_begin',
                [
                    '#include <normal_fragment_begin>',
                    '\tnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz * 0.75 + normalize(vViewPosition) * 0.35);',
                    '\tnonPerturbedNormal = normal;',
                ].join('\n'),
            ],
        ],
    });
}

/**
 * @param {THREE.InstancedMesh} mesh
 */
function finishInstanced(mesh) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
    }
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
}

// ── Цветове ──────────────────────────────────────────────────────────────

const _hsl = { h: 0, s: 0, l: 0 };
const _jittered = new THREE.Color();

/**
 * HSL jitter (h ±0.02, s ±0.10, l ±0.12) като МНОЖИТЕЛ спрямо базовия цвят:
 * вертексните цветове вече носят цвета на короната, instanceColor го умножава.
 *
 * @param {THREE.Color} base
 * @param {number} seed
 * @param {THREE.Color} out
 * @returns {THREE.Color} out
 */
function jitterMultiplier(base, seed, out) {
    jitterColor(base, seed, _jittered);
    out.setRGB(
        Math.min(1.8, Math.max(0.4, _jittered.r / Math.max(base.r, 0.02))),
        Math.min(1.8, Math.max(0.4, _jittered.g / Math.max(base.g, 0.02))),
        Math.min(1.8, Math.max(0.4, _jittered.b / Math.max(base.b, 0.02)))
    );

    return out;
}

/**
 * Абсолютен HSL jitter на цвят.
 *
 * @param {THREE.Color} base
 * @param {number} seed
 * @param {THREE.Color} out
 * @returns {THREE.Color} out
 */
function jitterColor(base, seed, out) {
    base.getHSL(_hsl);
    out.setHSL(
        (_hsl.h + (hashNoise(seed * 1.31) - 0.5) * 0.04 + 1) % 1,
        clamp01(_hsl.s + (hashNoise(seed * 2.17) - 0.5) * 0.2),
        clamp01(_hsl.l + (hashNoise(seed * 3.07) - 0.5) * 0.24)
    );

    return out;
}

// ── Помощни ──────────────────────────────────────────────────────────────

/**
 * Височина на тревната лента при ред i и странично отместване (метри,
 * знаково по нормалата) — огледало на ribbonMesh в mesh.js: спадът тръгва от
 * ръба на асфалта, банкингът накланя и банкета.
 *
 * @param {import('./track.js').Track} track
 * @param {number} i
 * @param {number} offset
 * @returns {number}
 */
function ribbonY(track, i, offset) {
    const half = track.halfWidths[i];

    return track.ys[i] + RIBBON.y - Math.max(0, Math.abs(offset) - half) * RIBBON.drop - offset * track.bankSlope[i];
}

/**
 * Детерминиран шум в [0,1) от число (същият като в mesh.js/decor.js).
 *
 * @param {number} n
 * @returns {number}
 */
function hashNoise(n) {
    const x = Math.sin(n * 12.9898) * 43758.5453;

    return x - Math.floor(x);
}

/** Двумерен value noise с кубична интерполация, детерминиран. */
function noise2(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);

    const h = (a, b) => hashNoise(a * 157.31 + b * 313.97);
    const a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * sx;
    const b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * sx;

    return a + (b - a) * sz;
}

/** Две октави — поляни и масиви в гората. */
function fbm2(x, z) {
    return noise2(x, z) * 0.65 + noise2(x * 2.7 + 11, z * 2.7 - 7) * 0.35;
}

/**
 * @param {number} v
 * @returns {number}
 */
function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
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
