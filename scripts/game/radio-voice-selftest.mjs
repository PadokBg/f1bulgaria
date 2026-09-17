/**
 * Селфтест на гласа на радиото (resources/js/game/radioVoice.js) с фалшив
 * плейър и fetch: случаен инженер за състезание (различен от предишния),
 * ред на клиповете, къса опашка, приоритет на наказанията, пропускане на
 * остарели съобщения и тихо текстово радио без клипове.
 *
 *   node scripts/game/radio-voice-selftest.mjs
 */

import { createRadioVoice } from '../../resources/js/game/radioVoice.js';

const fail = (message) => {
    console.error(`СЕЛФТЕСТ (радио глас): ${message}`);
    process.exit(1);
};

const clipsFor = (voice) =>
    Object.fromEntries(
        ['a', 'b', 'c', 'd', 'penalty'].map((id) => [id, { file: `${voice}/${id}.mp3`, hash: `hash-${voice}-${id}-123` }])
    );

const MANIFEST = {
    version: 1,
    voices: {
        daniel: { id: 'v-daniel', clips: clipsFor('daniel') },
        adam: { id: 'v-adam', clips: clipsFor('adam') },
    },
};

function harness({ manifest = MANIFEST, playMs = 5, randoms = [0] } = {}) {
    let clock = 0;
    let draw = 0;
    const played = [];
    const fetched = [];

    const fetchImpl = async (url) => {
        fetched.push(url);
        if (url.endsWith('manifest.json')) {
            return manifest ? { ok: true, json: async () => manifest } : { ok: false };
        }
        const key = url.replace('/radio/', '').split('.mp3')[0];
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(key).buffer };
    };

    const player = {
        async decodeClip(data) {
            return { key: new TextDecoder().decode(data) };
        },
        async playRadio(buffer) {
            played.push(buffer.key);
            clock += playMs;
            await new Promise((resolve) => setTimeout(resolve, 1));
        },
    };

    const voice = createRadioVoice(player, {
        fetch: fetchImpl,
        baseUrl: '/radio/',
        now: () => clock,
        random: () => randoms[draw++ % randoms.length],
    });

    return { voice, played, fetched };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// 1. Инженерът се избира при старта; клиповете му звучат по ред.
{
    const { voice, played, fetched } = harness({ randoms: [0.99] });
    await voice.startRace();
    const engineer = voice.voice();
    if (!['daniel', 'adam'].includes(engineer)) fail(`няма избран инженер: ${engineer}`);
    voice.say(['a', 'b']);
    voice.say(['c']);
    await settle();
    const expected = ['a', 'b', 'c'].map((id) => `${engineer}/${id}`).join(',');
    if (played.join(',') !== expected) fail(`редът е ${played.join(',')}, очаквано ${expected}`);
    if (fetched.some((url) => url.includes('.mp3') && !url.includes(`/${engineer}/`))) fail('изтеглени са клипове на друг инженер');
}

// 2. Следващото състезание е с различен инженер, когато има избор.
{
    const { voice } = harness({ randoms: [0, 0, 0] });
    await voice.startRace();
    const first = voice.voice();
    await voice.startRace();
    if (voice.voice() === first) fail(`същият инженер (${first}) две състезания поред`);
}

// 3. Препълнената опашка изхвърля най-старото чакащо, не текущото.
{
    const { voice, played } = harness();
    await voice.startRace();
    const v = voice.voice();
    voice.say(['a']); // тръгва веднага
    voice.say(['b']);
    voice.say(['c']);
    voice.say(['d']); // b отпада
    await settle();
    if (played.join(',') !== `${v}/a,${v}/c,${v}/d`) fail(`при препълване звучи ${played.join(',')}`);
}

// 4. Наказанието минава преди чакащите и не отпада при препълване.
{
    const { voice, played } = harness();
    await voice.startRace();
    voice.say(['a']);
    voice.say(['b']);
    voice.say(['penalty'], true);
    voice.say(['c']);
    voice.say(['d']);
    await settle();
    if (!played[1]?.endsWith('/penalty')) fail(`наказанието не е веднага след текущото: ${played.join(',')}`);
}

// 5. Остаряло съобщение (чакало над 2.5 s) не се казва.
{
    const { voice, played } = harness({ playMs: 3000 });
    await voice.startRace();
    voice.say(['a']); // трае 3 s по фалшивия часовник
    voice.say(['b']); // докато a свири, b остарява
    await settle();
    if (played.length !== 1) fail(`остаряло съобщение прозвуча: ${played.join(',')}`);
}

// 6. Без manifest (клиповете не са генерирани) радиото мълчи без грешка.
{
    const { voice, played } = harness({ manifest: null });
    await voice.startRace();
    voice.say(['a']);
    await settle();
    if (played.length !== 0 || voice.available()) fail('без manifest гласът не бива да звучи');
}

// 7. Изключеният глас не звучи и чисти опашката.
{
    const { voice, played } = harness();
    await voice.startRace();
    voice.setEnabled(false);
    voice.say(['a']);
    await settle();
    if (played.length !== 0 || voice.available()) fail('изключеният глас прозвуча');
}

console.log('Радио глас: случаен инженер, ред, опашка, приоритет, остаряване и тихо радио — OK.');
