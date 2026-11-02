<script setup>
import { usePage } from '@inertiajs/vue3';
import { computed, onMounted, ref } from 'vue';

const props = defineProps({
    // id за линкове отвън (напр. /leaderboard#kak-se-tochkuva от отговор на
    // писмо). Такъв линк отваря блока — иначе браузърът само скролва до
    // сгънатия <details> и човек пак не вижда правилата.
    anchor: { type: String, default: null },
});

// Стойностите идват от config('predictions.scoring') (споделен prop), за да
// не се разминат с точкуването, ако схемата пак се пренастрои.
const scoring = computed(() => usePage().props.predictionScoring ?? null);

const podiumMax = computed(() => Object.values(scoring.value?.exact ?? {})
    .reduce((sum, points) => sum + points, 0));

const bonusMax = computed(() => {
    const rules = scoring.value;

    return rules ? rules.pole + rules.fastest_lap + rules.dnf_exact + rules.safety_car : 0;
});

const details = ref(null);

onMounted(() => {
    if (props.anchor && details.value && window.location.hash === `#${props.anchor}`) {
        details.value.open = true;
    }
});
</script>

<template>
    <!-- scroll-mt-24: котвата иначе спира под лепкавата навигация. -->
    <details v-if="scoring" :id="anchor" ref="details" class="scroll-mt-24">
        <summary class="cursor-pointer text-sm font-medium text-zinc-400 transition hover:text-zinc-200">
            Как се точкува?
        </summary>

        <!-- max-w-xl: в цялата ширина на класирането числата се отдалечаваха
             на ~900px от етикетите си. -->
        <div class="mt-3 max-w-xl space-y-4 rounded-lg border border-zinc-800 bg-black/40 p-4 text-sm">
            <div>
                <p class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Подиум — до {{ podiumMax }} т.</p>
                <ul class="mt-2 space-y-1.5 text-zinc-300">
                    <li class="flex justify-between gap-3">
                        <!-- Поредицата не се къса, за да съвпада с „25 / 18 / 15" до нея. -->
                        <span>Точно място: <span class="whitespace-nowrap">P1 / P2 / P3</span></span>
                        <span class="shrink-0 font-semibold tabular-nums text-white">
                            {{ scoring.exact.p1 }} / {{ scoring.exact.p2 }} / {{ scoring.exact.p3 }} т.
                        </span>
                    </li>
                    <li class="flex justify-between gap-3">
                        <span>Пилот от твоя подиум, завършил в топ 3 на друго място</span>
                        <span class="shrink-0 font-semibold tabular-nums text-white">{{ scoring.podium_partial }} т.</span>
                    </li>
                </ul>
            </div>

            <div>
                <p class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Бонуси — до {{ bonusMax }} т., по избор</p>
                <ul class="mt-2 space-y-1.5 text-zinc-300">
                    <li class="flex justify-between gap-3">
                        <span>Pole позиция</span>
                        <span class="shrink-0 font-semibold tabular-nums text-white">{{ scoring.pole }} т.</span>
                    </li>
                    <li class="flex justify-between gap-3">
                        <span>Най-бърза обиколка</span>
                        <span class="shrink-0 font-semibold tabular-nums text-white">{{ scoring.fastest_lap }} т.</span>
                    </li>
                    <!-- Два реда вместо „точно / с разлика от един — 5 / 2": в тясната
                         колона поредицата се късаше и числата не се връзваха. -->
                    <li class="flex justify-between gap-3">
                        <span>Брой отпаднали — точно</span>
                        <span class="shrink-0 font-semibold tabular-nums text-white">{{ scoring.dnf_exact }} т.</span>
                    </li>
                    <li class="flex justify-between gap-3">
                        <span>Брой отпаднали — с разлика от един</span>
                        <span class="shrink-0 font-semibold tabular-nums text-white">{{ scoring.dnf_close }} т.</span>
                    </li>
                    <li class="flex justify-between gap-3">
                        <span>Safety car (да/не)</span>
                        <span class="shrink-0 font-semibold tabular-nums text-white">{{ scoring.safety_car }} т.</span>
                    </li>
                </ul>
            </div>

            <p class="text-zinc-400">
                Пример: посочил си победител, а той завърши втори — взимаш {{ scoring.podium_partial }} т. вместо {{ scoring.exact.p1 }}.
            </p>

            <p class="text-xs text-zinc-500">
                Максимум {{ podiumMax + bonusMax }} т. на състезание. Точкува се само главното състезание, не спринтът.
            </p>
        </div>
    </details>
</template>
