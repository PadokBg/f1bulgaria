/**
 * Обиколката (или състезанието) на гост, изчакваща вход.
 *
 * Дотук гост можеше да кара, да направи чисто време и то просто изчезваше —
 * `/game/lap` е зад `auth`, а клиентът дори не опитваше да го изпрати. Затова
 * класацията стоеше празна при стотици посещения. Сега бегът се оставя тук,
 * човекът влиза или се регистрира, и при връщането в играта се изпраща сам.
 *
 * Пазеното е в localStorage, защото трябва да преживее пренасочването през
 * /login. Всеки достъп е в try/catch: в частен прозорец и при пълна квота
 * localStorage хвърля, а играта не бива да пада заради това.
 */

const STORAGE_KEY = 'padok.pending_game_run';

/** По-стар бег не се изпраща: междувременно писта или симулация може да са се сменили. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Трейсът на състезание е няколкостотин килобайта, а типичната квота на
 * localStorage е ~5 MB. Над тавана не пазим нищо — по-добре без запазен бег,
 * отколкото счупено хранилище.
 */
const MAX_TRACE_CHARS = 620000;

/**
 * Оставя бег за изпращане след вход.
 *
 * @param {{kind: 'lap'|'race', track: string, sim_version: number, payload: object}} run
 * @returns {boolean} дали бегът наистина е запазен
 */
export function stashPendingRun(run) {
    if (!run?.kind || !run?.track || typeof run.payload?.trace !== 'string') {
        return false;
    }

    if (run.payload.trace.length > MAX_TRACE_CHARS) {
        return false;
    }

    try {
        window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ ...run, saved_at: Date.now() }),
        );

        return true;
    } catch {
        // Пълна квота или забранено хранилище — гостът пак вижда позицията си,
        // просто ще трябва да покара отново след вход.
        return false;
    }
}

/**
 * Чакащият бег, ако още е годен за изпращане.
 *
 * @param {{simVersion: number, track?: string}} expected
 * @returns {{kind: string, track: string, sim_version: number, payload: object}|null}
 */
export function readPendingRun({ simVersion, track = null }) {
    let stored = null;

    try {
        stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }

    if (!stored) {
        return null;
    }

    let run = null;

    try {
        run = JSON.parse(stored);
    } catch {
        clearPendingRun();

        return null;
    }

    const stale = !Number.isFinite(run?.saved_at) || Date.now() - run.saved_at > MAX_AGE_MS;
    // Несъвпадаща SIM версия така или иначе се отхвърля от сървъра (виж
    // ValidateGameLapJob) — хвърляме я тук, вместо да показваме фалшива надежда.
    const wrongVersion = run?.sim_version !== simVersion;

    if (stale || wrongVersion || !['lap', 'race'].includes(run?.kind)) {
        clearPendingRun();

        return null;
    }

    if (track !== null && run.track !== track) {
        return null;
    }

    return run;
}

/** Изхвърля чакащия бег — след успешно изпращане или когато е негоден. */
export function clearPendingRun() {
    try {
        window.localStorage.removeItem(STORAGE_KEY);
    } catch {
        // Няма какво да се направи; при следващо четене просто ще е негоден.
    }
}
