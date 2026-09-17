/**
 * Deterministic pursuit controller used by the Node self-test and AI opponents.
 *
 * The public API deliberately stays small. Racecraft state is kept per Simulation
 * in a WeakMap, so callers may keep passing short-lived option objects (the ghost
 * builder does this) without losing an overtake or defence halfway through it.
 *
 * Speed comes from a per-track plan derived from the car model in physics.js
 * (grip + downforce, banking, crests, steering lock, real braking), not from
 * hand-tuned caps — a bot must be able to race a human, not idle ahead of one.
 * Everything uses + − × / √ only, so the plan is identical in every JS engine.
 */

import { CAR } from './physics.js';

const EMPTY_OPTIONS = Object.freeze({});
const TRACK_PLANS = new WeakMap();
const DRIVER_STATES = new WeakMap();

const TWO_PI = Math.PI * 2;
const GRAVITY = 9.81;
const PASS_OFFSET = 2.55;
const DEFEND_OFFSET = 1.35;
const AVOID_OFFSET = 3.05;
const PASS_MAX_TICKS = 7 * 120;
const DEFEND_MAX_TICKS = 3 * 120;
const MANEUVER_RATE = 3.8 / 120;
const RETURN_RATE = 2.0 / 120;
const TRAFFIC_DECEL = 26;
/** Stuck this long close behind a car, a driver attacks without a speed edge. */
const PRESSURE_TICKS = Math.round(1.5 * 120);
const PRESSURE_GAP = 22;
/** Alongside a rival mid-pass a driver takes a little more risk (pace ×). */
const ATTACK_PACE = 1.03;

/**
 * Speed planner budget at pace 1. Exported (mutable) only so the offline tuner
 * (scripts/game/bot-tune.mjs) can search it; the game never changes it.
 */
export const PLANNER = {
    /** Share of the tyre's lateral grip a corner is planned for. */
    lateralUse: 0.98,
    /** Share of the real braking deceleration the braking zones assume. */
    brakeUse: 0.97,
    /** Required front-wheel angle × this must fit the speed-limited steering lock. */
    steerMargin: 1.2,
    /** Seconds ahead the controller already obeys the plan (pedal ramps + reaction). */
    reactionTime: 0.22,
    /** Above this share of lateral grip in use, the throttle stays shut (exit traction). */
    exitLateralUse: 0.82,
    /** Floor for any planned speed, m/s. */
    minSpeed: 4.5,
    /** Pursuit look-ahead per m/s of speed (≈ seconds ahead on the line). */
    lookAheadTime: 0.55,
    /** Steering damping on yaw rate — stops the weave at high speed. */
    yawDamping: 0.12,
};

/**
 * Calculate one fixed-tick input. Mutates and returns `input`.
 *
 * @param {import('./sim.js').Simulation} sim
 * @param {{steer: number, throttle: number, brake: number}} input
 * @param {{pace?: number, steerGain?: number, lookBias?: number,
 *          lineOffset?: number, mistakeFactor?: number,
 *          others?: Array<import('./sim.js').Simulation>}} [opts]
 * @returns {{steer: number, throttle: number, brake: number}}
 */
export function driveAutopilot(sim, input, opts = EMPTY_OPTIONS) {
    const pace = opts.pace ?? 1;
    const steerGain = opts.steerGain ?? 2.8;
    const lookBias = opts.lookBias ?? 0;
    const personalOffset = opts.lineOffset ?? 0;
    const others = opts.others;

    const track = sim.track;
    const state = sim.state;
    const hint = normalizeIndex(sim.trackIndexHint ?? 0, track.count);
    const driver = driverStateFor(sim);

    refreshDriverState(driver, sim);
    if (driver.passCooldown > 0) driver.passCooldown--;
    if (driver.defendCooldown > 0) driver.defendCooldown--;

    const ownProgress = progressOf(sim, hint);
    const ownLateral = lateralPosition(sim, hint);
    const ownSpeed = Math.max(0, state.vForward);

    let frontSim = null;
    let frontGap = Infinity;
    let frontLateral = 0;
    let frontSpeed = 0;

    let rearSim = null;
    let rearGap = -Infinity;
    let rearLateral = 0;
    let rearSpeed = 0;

    let sideSim = null;
    let sideGap = Infinity;
    let sideLateral = 0;

    let passSeen = false;
    let passGap = Infinity;
    let passLateral = 0;
    let defendSeen = false;
    let defendGap = -Infinity;

    if (others) {
        for (let i = 0; i < others.length; i++) {
            const otherSim = others[i];
            if (!otherSim || otherSim === sim || otherSim.recovering) continue;

            const otherHint = normalizeIndex(otherSim.trackIndexHint ?? 0, track.count);
            const gap = relativeGap(
                ownProgress,
                progressOf(otherSim, otherHint),
                track.length
            );
            const otherLateral = lateralPosition(otherSim, otherHint);
            const lateralGap = otherLateral - ownLateral;
            const otherSpeed = Math.max(0, otherSim.state.vForward);

            if (otherSim === driver.passTarget) {
                passSeen = true;
                passGap = gap;
                passLateral = lateralGap;
            }
            if (otherSim === driver.defendTarget) {
                defendSeen = true;
                defendGap = gap;
            }

            // Cars on another section of a crossing track are excluded by progress,
            // instead of relying on world-space distance alone.
            if (
                gap > 0.35 &&
                gap < 46 &&
                Math.abs(lateralGap) < 3.65 &&
                gap < frontGap
            ) {
                frontSim = otherSim;
                frontGap = gap;
                frontLateral = otherLateral;
                frontSpeed = otherSpeed;
            }

            if (
                gap < -0.35 &&
                gap > -28 &&
                Math.abs(lateralGap) < 4.2 &&
                gap > rearGap
            ) {
                rearSim = otherSim;
                rearGap = gap;
                rearLateral = otherLateral;
                rearSpeed = otherSpeed;
            }

            if (
                Math.abs(gap) < 4.8 &&
                Math.abs(lateralGap) < 2.45 &&
                Math.abs(gap) < Math.abs(sideGap)
            ) {
                sideSim = otherSim;
                sideGap = gap;
                sideLateral = lateralGap;
            }
        }
    }

    // Pressure: how long this driver has been glued to the car ahead in the
    // same lane. Racing drivers do not queue politely forever.
    if (frontSim && frontGap < PRESSURE_GAP && Math.abs(frontLateral - ownLateral) < 2.3) {
        driver.followTicks++;
    } else {
        driver.followTicks = 0;
    }

    updatePassState(
        driver,
        sim,
        opts,
        frontSim,
        frontGap,
        frontLateral,
        frontSpeed,
        passSeen,
        passGap,
        ownLateral,
        ownSpeed,
        hint
    );
    updateDefenceState(
        driver,
        sim,
        opts,
        rearSim,
        rearGap,
        rearLateral,
        rearSpeed,
        defendSeen,
        defendGap,
        ownLateral,
        ownSpeed,
        hint
    );

    let maneuverTarget = 0;
    if (driver.passTarget) {
        driver.passTicks++;
        maneuverTarget = driver.passSide * PASS_OFFSET;
    } else if (driver.defendTarget && defendGap < -4.5) {
        driver.defendTicks++;
        maneuverTarget = driver.defendSide * DEFEND_OFFSET;
    }

    let emergencyTrafficBrake = false;
    if (sideSim) {
        let escapeSide = sideLateral > 0 ? -1 : 1;
        if (Math.abs(sideLateral) < 0.05) {
            escapeSide = driver.passSide || driverBias(opts);
        }

        const base = track.raceOffset[hint] + personalOffset;
        if (laneFits(track, hint, base + escapeSide * AVOID_OFFSET, 0.15)) {
            maneuverTarget = escapeSide * AVOID_OFFSET;
        } else {
            // Only the car behind yields. The old `sideGap > -2.8` braked BOTH
            // cars of a side-by-side pair in a narrow chicane — each saw the
            // other in range — and at a standstill they blocked the track for
            // the rest of the race. An exact tie yields by side.
            emergencyTrafficBrake = sideGap > 0 || (sideGap === 0 && sideLateral > 0);
        }
    }

    if (sim.recovering || sim.offSurface) {
        maneuverTarget = 0;
    }

    const maneuverDelta = maneuverTarget - driver.maneuverOffset;
    const maneuverRate = maneuverTarget === 0 ? RETURN_RATE : MANEUVER_RATE;
    driver.maneuverOffset += clamp(maneuverDelta, -maneuverRate, maneuverRate);

    const hereCurvature = Math.abs(track.raceCurv[hint]);
    const lookScale = 1 / (1 + hereCurvature * 6);
    const targetDistance =
        (10 + lookBias + ownSpeed * PLANNER.lookAheadTime) * lookScale;
    const target = indexAhead(track, hint, Math.max(track.spacing, targetDistance));

    const maxOffset = laneLimit(track, target);
    // A driver's own line only differs on straights; in corners everyone
    // needs the racing line — an offset apex puts street-circuit cars in the
    // wall. And only towards the middle: the racing line already hugs the edge
    // with the minimum margin, one step further out is grass under braking.
    const outward = personalOffset * track.raceOffset[target] > 0;
    const lineFade = outward ? 0 : clamp(1 - Math.abs(track.raceCurv[target]) * 60, 0, 1);
    const offset = clamp(
        track.raceOffset[target] + personalOffset * lineFade + driver.maneuverOffset,
        -maxOffset,
        maxOffset
    );
    const dx = track.xs[target] + track.nx[target] * offset - state.x;
    const dz = track.zs[target] + track.nz[target] * offset - state.z;
    const desiredHeading = Math.atan2(dx, dz);
    const headingError = wrapAngle(desiredHeading - state.heading);

    // A small yaw-rate term damps weave when returning from a completed move.
    input.steer = clamp(headingError * steerGain - state.yawRate * PLANNER.yawDamping, -1, 1);

    // The plan is already a braking envelope: obeying it a reaction time
    // ahead leaves room for the pedal ramps to reach full brake.
    const attacking = driver.passTarget !== null && Math.abs(passGap) < 12;
    // mistakeFactor (race.js): a late-braking error plans this corner too fast.
    const planPace = (attacking ? Math.min(1, pace * ATTACK_PACE) : pace) * (opts.mistakeFactor ?? 1);
    const speedPlan = speedPlanFor(track, planPace);
    let safeSpeed = Infinity;
    const reactionDistance = ownSpeed * PLANNER.reactionTime + track.spacing;
    for (let distance = 0; distance <= reactionDistance; distance += track.spacing) {
        const planned = speedPlan[indexAhead(track, hint, distance)];
        if (planned < safeSpeed) safeSpeed = planned;
    }

    // Off the racing line (passing, defending) a corner is slower. Straights
    // are not: the penalty only bites where the plan is below top speed.
    const linePenalty = 1 - Math.min(0.05, Math.abs(driver.maneuverOffset) * 0.015);
    if (safeSpeed < CAR.maxSpeed - 1) {
        safeSpeed *= linePenalty;
    }

    // Keep a real stopping envelope behind a car until there is enough actual
    // lateral separation to call the overtake established.
    if (frontSim && Math.abs(frontLateral - ownLateral) < 2.3) {
        // A time gap, not a fixed distance: at speed (and in the tow) the car
        // ahead brakes harder than a 5 m cushion absorbs.
        const standOff = 5.3 + ownSpeed * 0.1 + Math.max(0, ownSpeed - frontSpeed) * 0.12;
        const usableGap = Math.max(0, frontGap - standOff);
        const followSpeed = Math.sqrt(
            Math.max(0, frontSpeed * frontSpeed + 2 * TRAFFIC_DECEL * usableGap)
        );
        safeSpeed = Math.min(safeSpeed, followSpeed);

        if (
            frontGap < 5.5 ||
            (frontGap < 9 && ownSpeed > frontSpeed + 2.5)
        ) {
            emergencyTrafficBrake = true;
        }
    }

    if (sim.offSurface) {
        safeSpeed = Math.min(safeSpeed, 18);
    }

    const overspeed = ownSpeed - safeSpeed;
    const brakeMargin = Math.max(1.2, safeSpeed * 0.025);
    input.brake = overspeed > brakeMargin || emergencyTrafficBrake ? 1 : 0;

    // Friction circle: full throttle mid-corner takes the rear's lateral grip
    // and spins the car, so power waits until the corner opens up.
    const lateralUse =
        (ownSpeed * ownSpeed * Math.abs(track.raceCurv[hint])) /
        (CAR.baseGrip + CAR.downforceCoef * ownSpeed * ownSpeed);
    input.throttle =
        !input.brake &&
        ownSpeed < safeSpeed - 0.5 &&
        lateralUse < PLANNER.exitLateralUse &&
        !sim.recovering
            ? 1
            : 0;

    driver.lastTick = Number.isFinite(sim._simTick) ? sim._simTick : driver.lastTick + 1;
    driver.lastX = state.x;
    driver.lastZ = state.z;

    return input;
}

/**
 * Start, hold and finish a pass. The chosen side is latched, which prevents the
 * old left/right oscillation when two lane scores are almost equal.
 */
function updatePassState(
    driver,
    sim,
    opts,
    frontSim,
    frontGap,
    frontLateral,
    frontSpeed,
    passSeen,
    passGap,
    ownLateral,
    ownSpeed,
    hint
) {
    if (driver.passTarget) {
        if (
            !passSeen ||
            driver.passTarget.recovering ||
            passGap < -9 ||
            passGap > 55 ||
            driver.passTicks >= PASS_MAX_TICKS ||
            sim.offSurface
        ) {
            clearPass(driver, 180);
        }
        return;
    }

    if (
        !frontSim ||
        driver.passCooldown > 0 ||
        driver.defendTarget ||
        sim.offSurface ||
        sim.recovering
    ) {
        return;
    }

    const closingSpeed = ownSpeed - frontSpeed;
    const pressured = driver.followTicks > PRESSURE_TICKS && closingSpeed > -1.5;
    if ((closingSpeed <= 0.8 && !pressured) || ownSpeed < 7) return;

    const catchDistance =
        (ownSpeed * ownSpeed - frontSpeed * frontSpeed) / (2 * TRAFFIC_DECEL) + 7;
    // Pull out late: leaving the slipstream at 39 m (the old trigger) meant the
    // attacker lost the tow long before reaching the car ahead.
    const triggerDistance = pressured ? PRESSURE_GAP : clamp(catchDistance, 10, 24);
    if (frontGap > triggerDistance) return;

    // Do not initiate a lane change at the apex. An already active move is held.
    if (Math.abs(sim.track.raceCurv[hint]) > 0.045) return;

    const side = choosePassSide(
        sim,
        opts,
        frontSim,
        frontLateral,
        ownLateral,
        hint
    );
    if (side === 0) return;

    driver.passTarget = frontSim;
    driver.passSide = side;
    driver.passTicks = 0;
    clearDefence(driver, 120);
}

/**
 * Make one restrained defensive move when a faster car will arrive shortly.
 * Defence stops before the cars overlap, leaving side-by-side avoidance in charge.
 */
function updateDefenceState(
    driver,
    sim,
    opts,
    rearSim,
    rearGap,
    rearLateral,
    rearSpeed,
    defendSeen,
    defendGap,
    ownLateral,
    ownSpeed,
    hint
) {
    if (driver.defendTarget) {
        if (
            !defendSeen ||
            driver.defendTarget.recovering ||
            defendGap > 1 ||
            defendGap < -34 ||
            driver.defendTicks >= DEFEND_MAX_TICKS ||
            sim.offSurface
        ) {
            clearDefence(driver, 240);
        }
        return;
    }

    if (
        !rearSim ||
        driver.defendCooldown > 0 ||
        driver.passTarget ||
        sim.offSurface ||
        sim.recovering ||
        ownSpeed < 12
    ) {
        return;
    }

    const closingSpeed = rearSpeed - ownSpeed;
    if (closingSpeed <= 1.5) return;

    const timeToArrival = -rearGap / closingSpeed;
    if (timeToArrival > 2.6 || Math.abs(sim.track.raceCurv[hint]) > 0.04) return;

    const turnSide = futureTurnSide(sim.track, hint);
    const threatSide = signNonZero(rearLateral - ownLateral);
    let side = turnSide || threatSide || driverBias(opts);
    const base = sim.track.raceOffset[hint] + (opts.lineOffset ?? 0);

    if (!laneFits(sim.track, hint, base + side * DEFEND_OFFSET, 0.35)) {
        side *= -1;
    }
    if (!laneFits(sim.track, hint, base + side * DEFEND_OFFSET, 0.35)) return;

    driver.defendTarget = rearSim;
    driver.defendSide = side;
    driver.defendTicks = 0;
}

/**
 * Score both usable lanes without sorting or allocating. Room around other cars,
 * braking-side positioning and the driver's stable bias decide ties.
 */
function choosePassSide(sim, opts, leader, leaderLateral, ownLateral, hint) {
    const track = sim.track;
    const base = track.raceOffset[hint] + (opts.lineOffset ?? 0);
    const turnSide = futureTurnSide(track, hint);
    const bias = driverBias(opts);

    let bestSide = 0;
    let bestScore = -Infinity;

    for (let side = -1; side <= 1; side += 2) {
        const candidate = base + side * PASS_OFFSET;
        if (!laneFits(track, hint, candidate, 0.25)) continue;

        const futureIndex = indexAhead(track, hint, 28);
        const futureCandidate =
            track.raceOffset[futureIndex] + (opts.lineOffset ?? 0) + side * PASS_OFFSET;
        if (!laneFits(track, futureIndex, futureCandidate, 0.15)) continue;

        let score = (laneLimit(track, hint) - Math.abs(candidate)) * 0.35;
        score += Math.abs(candidate - leaderLateral) * 0.22;
        if (side === turnSide) score += 0.7;
        if (side === bias) score += 0.12;

        const others = opts.others;
        if (others) {
            const ownProgress = progressOf(sim, hint);
            for (let i = 0; i < others.length; i++) {
                const other = others[i];
                if (!other || other === sim || other === leader || other.recovering) {
                    continue;
                }
                const otherHint = normalizeIndex(other.trackIndexHint ?? 0, track.count);
                const gap = relativeGap(
                    ownProgress,
                    progressOf(other, otherHint),
                    track.length
                );
                if (gap < -4 || gap > 25) continue;

                const clearance = Math.abs(
                    candidate - lateralPosition(other, otherHint)
                );
                if (clearance < 2.35) {
                    score -= 2.5 + (2.35 - clearance) * 4;
                }
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestSide = side;
        }
    }

    // A fully occupied lane should make the driver queue rather than force a gap.
    return bestScore > -1 ? bestSide : 0;
}

/**
 * Забравя тактическото състояние на пилота (изпреварване/защита/охлаждане).
 * Решетката на ново състезание го вика изрично: сървърното повторение тръгва
 * с чист пилот и клиентът трябва да тръгне от СЪЩОТО, а не да разчита, че
 * refreshDriverState ще усети рестарта.
 *
 * @param {import('./sim.js').Simulation} sim
 */
export function resetAutopilotDriver(sim) {
    DRIVER_STATES.delete(sim);
}

function trackPlanFor(track) {
    let plan = TRACK_PLANS.get(track);
    if (plan) return plan;

    // Peak racing-line curvature in a ±2 sample window: the sampled line
    // under-reads a hairpin's apex by a sample or two.
    const peakCurvature = new Float32Array(track.count);
    for (let i = 0; i < track.count; i++) {
        let peak = 0;
        for (let n = -2; n <= 2; n++) {
            peak = Math.max(
                peak,
                Math.abs(track.raceCurv[normalizeIndex(i + n, track.count)])
            );
        }
        peakCurvature[i] = peak;
    }

    plan = { peakCurvature, speeds: new Map() };
    TRACK_PLANS.set(track, plan);
    return plan;
}

/**
 * Target speed for every track sample at a given pace: the corner limit of
 * the car model, then a backward braking pass so every sample is reachable
 * from the next one under braking. Cached per track and pace.
 *
 * @param {import('./track.js').Track} track
 * @param {number} pace Scales the grip budget (1 = PLANNER as tuned)
 * @returns {Float32Array}
 */
export function speedPlanFor(track, pace) {
    const plan = trackPlanFor(track);
    const key = Math.round(pace * 10000);
    const cached = plan.speeds.get(key);
    if (cached) return cached;

    const count = track.count;
    const lateralUse = PLANNER.lateralUse * pace;
    const brakeUse = PLANNER.brakeUse * pace;
    const speeds = new Float64Array(count);

    for (let i = 0; i < count; i++) {
        speeds[i] = cornerLimit(track, i, plan.peakCurvature[i], lateralUse, pace);
    }

    // Two laps backwards so the braking zone before the start line settles too.
    for (let pass = 0; pass < 2; pass++) {
        for (let i = count - 1; i >= 0; i--) {
            const next = speeds[(i + 1) % count];
            const reachable = Math.sqrt(
                next * next + 2 * brakingDecel(next, brakeUse, track.gradient[i]) * track.spacing
            );
            if (reachable < speeds[i]) speeds[i] = reachable;
        }
    }

    const result = Float32Array.from(speeds);
    plan.speeds.set(key, result);
    return result;
}

/**
 * Highest steady speed through sample i: v²·κ must fit the lateral grip
 * (base + downforce, banking, crest/compression load) and the front wheels
 * must still reach the angle the corner needs at that speed.
 */
function cornerLimit(track, index, curvature, lateralUse, pace) {
    if (curvature < 1e-4) {
        return CAR.maxSpeed;
    }

    const bankGrip = 1 + Math.min(0.35, Math.abs(track.bankSlope[index]) * 1.1);
    const rawVertical = track.vertCurv[index];
    // Same dead zone and load clamps as sim.js.
    const vertical = Math.abs(rawVertical) < 0.0012 ? 0 : rawVertical;

    // Load depends on speed on a crest, so settle the fixed point in a fixed
    // number of steps (deterministic, converges in 2–3).
    let speed = CAR.maxSpeed;
    for (let iteration = 0; iteration < 4; iteration++) {
        const load = clamp(1 + (speed * speed * vertical) / GRAVITY, 0.25, 1.8);
        const grip = lateralUse * bankGrip * load;
        const denominator = curvature - grip * CAR.downforceCoef;
        speed = denominator <= 0
            ? CAR.maxSpeed
            : Math.min(CAR.maxSpeed, Math.sqrt((grip * CAR.baseGrip) / denominator));
    }

    // Steering lock shrinks with speed: maxSteerAngle / (1 + v·falloff).
    const steerLimit =
        ((CAR.maxSteerAngle * pace) / (PLANNER.steerMargin * CAR.wheelbase * curvature) - 1) /
        CAR.steerSpeedFalloff;

    return Math.max(PLANNER.minSpeed, Math.min(speed, steerLimit));
}

/** Deceleration available at speed v with the brake pedal down, m/s². */
function brakingDecel(speed, brakeUse, gradient) {
    const grip = CAR.baseGrip + CAR.downforceCoef * speed * speed;
    const brakes = Math.min(CAR.brakePower, CAR.brakeGripShare * grip) * brakeUse;
    const slope = (GRAVITY * gradient) / Math.sqrt(1 + gradient * gradient);

    return Math.max(
        1,
        brakes +
            CAR.drag * speed * speed +
            CAR.rollingResistance * speed +
            CAR.engineBraking * Math.min(1, speed / CAR.engineBrakingSpeed) +
            slope
    );
}

function driverStateFor(sim) {
    let driver = DRIVER_STATES.get(sim);
    if (driver) return driver;

    driver = {
        passTarget: null,
        passSide: 0,
        passTicks: 0,
        passCooldown: 0,
        followTicks: 0,
        defendTarget: null,
        defendSide: 0,
        defendTicks: 0,
        defendCooldown: 0,
        maneuverOffset: 0,
        lastTick: Number.isFinite(sim._simTick) ? sim._simTick : 0,
        lastX: sim.state.x,
        lastZ: sim.state.z,
    };
    DRIVER_STATES.set(sim, driver);
    return driver;
}

function refreshDriverState(driver, sim) {
    const tick = Number.isFinite(sim._simTick) ? sim._simTick : driver.lastTick;
    const dx = sim.state.x - driver.lastX;
    const dz = sim.state.z - driver.lastZ;
    if (tick < driver.lastTick || dx * dx + dz * dz > 2500) {
        clearPass(driver, 0);
        clearDefence(driver, 0);
        driver.maneuverOffset = 0;
        driver.passCooldown = 0;
        driver.defendCooldown = 0;
        driver.followTicks = 0;
    }
}

function clearPass(driver, cooldown) {
    driver.passTarget = null;
    driver.passSide = 0;
    driver.passTicks = 0;
    driver.passCooldown = Math.max(driver.passCooldown, cooldown);
}

function clearDefence(driver, cooldown) {
    driver.defendTarget = null;
    driver.defendSide = 0;
    driver.defendTicks = 0;
    driver.defendCooldown = Math.max(driver.defendCooldown, cooldown);
}

function futureTurnSide(track, hint) {
    let strongest = 0;
    for (let distance = 20; distance <= 100; distance += track.spacing * 2) {
        const curvature = track.raceCurv[indexAhead(track, hint, distance)];
        if (Math.abs(curvature) > Math.abs(strongest)) strongest = curvature;
    }
    return Math.abs(strongest) < 0.006 ? 0 : signNonZero(strongest);
}

function laneFits(track, index, offset, reserve) {
    return Math.abs(offset) <= laneLimit(track, index) - reserve;
}

function laneLimit(track, index) {
    return Math.max(0.6, track.halfWidths[index] - 1.2);
}

function progressOf(sim, hint) {
    const progress = sim.lastProgress;
    if (Number.isFinite(progress)) return progress;
    return hint / sim.track.count;
}

function lateralPosition(sim, hint) {
    const track = sim.track;
    return (
        (sim.state.x - track.xs[hint]) * track.nx[hint] +
        (sim.state.z - track.zs[hint]) * track.nz[hint]
    );
}

function relativeGap(ownProgress, otherProgress, trackLength) {
    let gap = (otherProgress - ownProgress) * trackLength;
    const halfLength = trackLength * 0.5;
    if (gap > halfLength) gap -= trackLength;
    if (gap < -halfLength) gap += trackLength;
    return gap;
}

function indexAhead(track, hint, distance) {
    return normalizeIndex(hint + Math.round(distance / track.spacing), track.count);
}

function normalizeIndex(index, count) {
    const wrapped = index % count;
    return wrapped < 0 ? wrapped + count : wrapped;
}

function driverBias(opts) {
    const lineOffset = opts.lineOffset ?? 0;
    if (Math.abs(lineOffset) > 0.01) return signNonZero(lineOffset);
    const lookBias = opts.lookBias ?? 0;
    if (Math.abs(lookBias) > 0.01) return signNonZero(lookBias);
    return 1;
}

function signNonZero(value) {
    return value < 0 ? -1 : 1;
}

function wrapAngle(angle) {
    angle %= TWO_PI;
    if (angle > Math.PI) return angle - TWO_PI;
    if (angle < -Math.PI) return angle + TWO_PI;
    return angle;
}

function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}
