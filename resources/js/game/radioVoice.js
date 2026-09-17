/**
 * Гласът на радиото: клиповете от `php artisan game:generate-radio-voice`
 * (manifest.json + mp3 в public/game-audio/radio/{инженер}/) се теглят и се
 * пускат по ред през player.playRadio (sound.js — радио филтър).
 *
 * Всяко състезание има СВОЙ инженер: startRace() избира случаен глас,
 * различен от предишния (един отбор — един глас по радиото, но не винаги
 * същият). Изборът е чисто презентационен, затова е Math.random — не пипа
 * детерминизма на симулацията.
 *
 * Съобщенията са спешни: „Колев е точно зад теб" две секунди по-късно е
 * лъжа. Затова опашката е къса, старите съобщения се пропускат, а
 * наказанията минават най-отпред. Липсващ manifest (клиповете още не са
 * генерирани) или липсващ клип → радиото остава само текстово, без грешка.
 */

/** Колко съобщения чакат най-много; при препълване отпада най-старото. */
const MAX_QUEUE = 2;

/** Съобщение, чакало по-дълго от това, вече не е вярно — пропуска се. */
const MAX_AGE_MS = 2500;

/**
 * @param {{decodeClip: (data: ArrayBuffer) => Promise<object|null>,
 *          playRadio: (buffer: object) => Promise<void>}} player
 * @param {{fetch?: typeof fetch, baseUrl?: string, now?: () => number,
 *          random?: () => number}} [options]
 */
export function createRadioVoice(player, options = {}) {
    const fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    const baseUrl = options.baseUrl ?? '/game-audio/radio/';
    const now = options.now ?? (() => performance.now());
    const random = options.random ?? Math.random;

    let manifestPromise = null;
    let manifest = null;
    let voice = null; // ключът на инженера за текущото състезание
    const clipData = new Map(); // "инженер/id" → Promise<ArrayBuffer|null>
    const decoded = new Map(); // "инженер/id" → AudioBuffer
    const queue = [];
    let playing = false;
    let enabled = true;

    const loadManifest = () => {
        manifestPromise ??= fetchImpl(`${baseUrl}manifest.json`)
            .then((response) => (response.ok ? response.json() : null))
            .then((json) => {
                manifest = json && typeof json.voices === 'object' && json.voices !== null ? json : null;
                return manifest;
            })
            .catch(() => null);

        return manifestPromise;
    };

    const voicesWithClips = () =>
        manifest === null
            ? []
            : Object.keys(manifest.voices).filter((key) => Object.keys(manifest.voices[key]?.clips ?? {}).length > 0);

    const loadClip = (voiceKey, id) => {
        const cacheKey = `${voiceKey}/${id}`;
        if (!clipData.has(cacheKey)) {
            clipData.set(
                cacheKey,
                loadManifest()
                    .then((loaded) => {
                        const clip = loaded?.voices?.[voiceKey]?.clips?.[id];
                        if (!clip) {
                            return null;
                        }
                        // Хешът в URL-а: регенериран клип не идва от стар кеш.
                        return fetchImpl(`${baseUrl}${clip.file}?v=${String(clip.hash).slice(0, 8)}`).then((response) =>
                            response.ok ? response.arrayBuffer() : null
                        );
                    })
                    .catch(() => null)
            );
        }

        return clipData.get(cacheKey);
    };

    const bufferFor = async (voiceKey, id) => {
        const cacheKey = `${voiceKey}/${id}`;
        if (decoded.has(cacheKey)) {
            return decoded.get(cacheKey);
        }
        const data = await loadClip(voiceKey, id);
        if (!data) {
            return null;
        }
        // decodeAudioData отнема буфера — копие, за да може да се опита пак
        // (напр. преди звукът да е тръгнал, когато още няма AudioContext).
        const audio = await player.decodeClip(data.slice(0));
        if (audio) {
            decoded.set(cacheKey, audio);
        }

        return audio;
    };

    const pump = async () => {
        if (playing) {
            return;
        }
        playing = true;
        try {
            while (queue.length > 0) {
                const item = queue.shift();
                if (!enabled || now() - item.at > MAX_AGE_MS) {
                    continue;
                }
                for (const id of item.ids) {
                    const audio = await bufferFor(item.voice, id);
                    if (audio && enabled) {
                        await player.playRadio(audio);
                    }
                }
            }
        } finally {
            playing = false;
        }
    };

    return {
        /**
         * Ново състезание: случаен инженер (различен от предишния, ако има
         * избор) и предварително изтеглени негови клипове — първото
         * съобщение да не закъснее.
         */
        async startRace() {
            queue.length = 0;
            await loadManifest();
            const voices = voicesWithClips();
            if (voices.length === 0) {
                voice = null;
                return;
            }

            const candidates = voices.length > 1 ? voices.filter((key) => key !== voice) : voices;
            voice = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];

            if (enabled) {
                await Promise.all(Object.keys(manifest.voices[voice].clips).map((id) => loadClip(voice, id)));
            }
        },

        /** Кой инженер кара това състезание (null без клипове). */
        voice() {
            return voice;
        },

        /** Има ли глас за текущото състезание. */
        available() {
            return enabled && voice !== null;
        },

        /**
         * @param {string[]} ids Клиповете на съобщението, по ред
         * @param {boolean} [priority] Наказанията: най-отпред и не отпадат
         */
        say(ids, priority = false) {
            if (!enabled || voice === null || ids.length === 0) {
                return;
            }

            const item = { ids, priority, voice, at: now() };
            if (priority) {
                const firstNormal = queue.findIndex((queued) => !queued.priority);
                queue.splice(firstNormal === -1 ? queue.length : firstNormal, 0, item);
            } else {
                queue.push(item);
            }

            while (queue.length > MAX_QUEUE) {
                const oldestNormal = queue.findIndex((queued) => !queued.priority);
                queue.splice(oldestNormal === -1 ? 0 : oldestNormal, 1);
            }

            void pump();
        },

        /** @param {boolean} value */
        setEnabled(value) {
            enabled = value;
            if (!value) {
                queue.length = 0;
            }
        },

        /** Чакащите съобщения са за старо състезание. */
        clear() {
            queue.length = 0;
        },
    };
}
