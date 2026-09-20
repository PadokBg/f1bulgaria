<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({
    raceId: { type: [Number, String], required: true },
});

/**
 * Временното класиране на прогнозите, докато тече състезанието.
 *
 * Пита на 30 s в ефир и на 2 минути извън него: страницата на кръга се отваря
 * и в четвъртък, а тогава няма какво да се обновява. Сървърът кешира за 15 s,
 * така че няколко отворени таба не умножават заявките към OpenF1.
 */
const LIVE_INTERVAL_MS = 30000;
const IDLE_INTERVAL_MS = 120000;

const live = ref(null);
const failures = ref(0);

let timer = null;

const schedule = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(poll, delay);
};

const poll = async () => {
    // Скрит таб не пита: състезанието трае два часа, а хората отварят и други
    // неща. При връщане visibilitychange стартира отново веднага.
    if (document.hidden) {
        schedule(IDLE_INTERVAL_MS);

        return;
    }

    try {
        const { data } = await window.axios.get(`/races/${props.raceId}/live-predictions`);
        live.value = data.live;
        failures.value = 0;
        schedule(data.live ? LIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
    } catch {
        // Пет поредни провала = нещо трайно (спрял OpenF1, 429). Спираме,
        // вместо да думкаме сървъра от всеки отворен браузър.
        failures.value += 1;

        if (failures.value < 5) {
            schedule(IDLE_INTERVAL_MS);
        }
    }
};

const onVisibility = () => {
    if (!document.hidden) {
        schedule(0);
    }
};

onMounted(() => {
    schedule(0);
    document.addEventListener('visibilitychange', onVisibility);
});

onBeforeUnmount(() => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
});

const MEDALS = ['🥇', '🥈', '🥉'];
</script>

<template>
    <section
        v-if="live"
        class="rounded-xl border border-[#e10600]/40 bg-[#e10600]/5 p-5"
        aria-live="polite"
    >
        <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="flex items-center gap-2 font-display text-lg font-bold text-white">
                <span class="relative flex h-2.5 w-2.5">
                    <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#e10600] opacity-75" />
                    <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#e10600]" />
                </span>
                Прогнозите на живо
            </h2>
            <span class="text-xs text-zinc-500">{{ live.predictors }} прогнозирали</span>
        </div>

        <!-- Челната тройка в момента — основата, по която се точкува. -->
        <ol class="mt-4 grid gap-2 sm:grid-cols-3">
            <li
                v-for="(row, i) in live.podium"
                :key="row.position"
                class="flex items-baseline gap-2 rounded-lg bg-black/30 px-3 py-2 text-sm"
            >
                <span>{{ MEDALS[i] }}</span>
                <span class="truncate font-medium text-zinc-200">{{ row.name }}</span>
            </li>
        </ol>

        <ol class="mt-4 divide-y divide-zinc-800/70">
            <li
                v-for="row in live.standings"
                :key="row.user_id"
                class="flex items-center justify-between gap-3 py-2 text-sm"
            >
                <span class="flex min-w-0 items-center gap-2">
                    <span class="w-5 shrink-0 text-right tabular-nums text-zinc-500">{{ row.position }}</span>
                    <span class="truncate text-zinc-200">{{ row.name }}</span>
                </span>
                <span class="shrink-0 font-display font-bold tabular-nums text-white">
                    {{ row.points }} т.
                </span>
            </li>
        </ol>

        <p class="mt-3 text-[11px] leading-relaxed text-zinc-500">
            Временно: точкува се само подиумът в момента (и полът от събота).
            Най-бърза обиколка, отпаднали и safety car се начисляват чак на финала.
        </p>
    </section>
</template>
