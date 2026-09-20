<script setup>
import LivePredictionsPanel from '@/Components/Predictions/LivePredictionsPanel.vue';
import PredictionBreakdown from '@/Components/Predictions/PredictionBreakdown.vue';
import SharePredictionButton from '@/Components/Predictions/SharePredictionButton.vue';
import PredictionForm from '@/Components/PredictionForm.vue';
import OtherPredictions from '@/Components/Races/OtherPredictions.vue';
import RacePreview from '@/Components/Races/RacePreview.vue';
import TableShell from '@/Components/UI/TableShell.vue';
import PublicLayout from '@/Layouts/PublicLayout.vue';
import { hasRoute } from '@/utils/routes';
import { Link, usePage } from '@inertiajs/vue3';
import { computed, ref } from 'vue';

const canOpenDriver = computed(() => hasRoute('drivers.show'));

const props = defineProps({
    race: Object,
    locked: Boolean,
    lockDeadline: String,
    userPrediction: Object,
    drivers: Array,
    // Класациите от всички сесии на уикенда, в реда на провеждането им.
    classifications: { type: Array, default: () => [] },
    // История на пистата — само докато няма класация от този уикенд.
    preview: { type: Object, default: null },
    neighbours: { type: Object, default: () => ({ prev: null, next: null }) },
    otherPredictions: { type: Array, default: () => [] },
    // { rank, total } в рамките на кръга; null преди точкуване.
    userRaceRank: { type: Object, default: null },
    // Има ли готов анализ на данните за този кръг (страницата му е /danni/{race}).
    hasDataRecap: { type: Boolean, default: false },
});

const user = computed(() => usePage().props.auth?.user);
const features = computed(() => usePage().props.features ?? {});

// По подразбиране последната проведена сесия — състезанието, ако го има,
// иначе квалификацията. Тя е причината човек да отвори страницата.
const selected = ref(props.classifications.at(-1)?.type ?? null);

const active = computed(
    () => props.classifications.find((c) => c.type === selected.value) ?? null,
);

const showsPoints = computed(() => ['race', 'sprint'].includes(active.value?.type));
const showsTime = computed(() => active.value?.rows.some((r) => r.time));
</script>

<template>

    <PublicLayout>
        <div class="mb-6">
            <Link :href="route('calendar')" class="text-sm text-zinc-500 transition hover:text-zinc-300">← Календар</Link>
            <h1 class="mt-2 font-display text-2xl font-black sm:text-3xl">
                <span class="text-red-600">Кръг {{ race.round }}</span> — {{ race.name_bg ?? race.name }}
            </h1>
            <p class="text-zinc-500">{{ race.circuit }}, {{ race.country }}</p>
        </div>

        <div class="grid gap-6 lg:grid-cols-3">
            <div class="min-w-0 space-y-6 lg:col-span-2">
                <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
                    <h2 class="mb-3 font-display text-lg font-bold text-white">Разписание <span class="text-xs font-normal text-zinc-500">(софийско време)</span></h2>
                    <ul class="divide-y divide-zinc-800 text-sm">
                        <li v-for="s in race.sessions" :key="s.type" class="flex justify-between py-2">
                            <span class="text-zinc-400">{{ s.label }}</span>
                            <span class="font-medium tabular-nums text-zinc-200">{{ s.scheduled_at_sofia ?? 'TBC' }}</span>
                        </li>
                    </ul>
                </section>

                <RacePreview v-if="preview" :preview="preview" :circuit="race.circuit" />

                <!-- „Падок на живо": докато тече състезанието, прогнозите се
                     точкуват по текущите позиции. Панелът сам се крие извън ефир. -->
                <LivePredictionsPanel v-if="features.live_predictions" :race-id="race.id" />

                <OtherPredictions :predictions="otherPredictions" />

                <TableShell v-if="active" class="bg-zinc-900/60">
                    <div class="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
                        <h2 class="mr-2 font-display text-lg font-bold text-white">Класация</h2>
                        <button v-for="c in classifications" :key="c.type" type="button"
                            class="rounded-lg px-2.5 py-1 text-xs font-medium transition"
                            :class="c.type === selected ? 'bg-red-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'"
                            @click="selected = c.type">{{ c.label }}</button>
                    </div>

                    <!-- Класация от бързия източник: показваме я веднага след
                         финала, но казваме, че точките още не са официални. -->
                    <p v-if="active.provisional" class="border-b border-zinc-800 bg-amber-500/5 px-4 py-2 text-xs text-amber-400">
                        Временна класация — официалните резултати и точките предстоят.
                    </p>

                    <table class="w-full whitespace-nowrap text-sm">
                        <thead class="bg-zinc-900/80 text-left text-xs uppercase tracking-wide text-zinc-500">
                            <tr>
                                <th scope="col" class="w-14 px-4 py-2.5">Поз.</th>
                                <th scope="col" class="px-4 py-2.5">Пилот</th>
                                <th v-if="showsTime" scope="col" class="px-4 py-2.5 text-right">Време</th>
                                <th v-if="showsPoints" scope="col" class="px-4 py-2.5 text-right">Точки</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-zinc-800/60">
                            <tr v-for="(r, i) in active.rows" :key="`${active.type}-${r.slug ?? i}`" class="transition hover:bg-zinc-800/40">
                                <td class="px-4 py-2.5 font-bold tabular-nums" :class="r.position ? 'text-zinc-200' : 'text-red-500'">
                                    {{ r.position ?? (r.dnf ? 'DNF' : '—') }}
                                </td>
                                <td class="px-4 py-2.5 text-zinc-200">
                                    <!-- Slug-ът вече идва с реда (ползва се и за :key) —
                                         дотук се харчеше само за него вместо за линк. -->
                                    <Link
                                        v-if="canOpenDriver && r.slug"
                                        :href="route('drivers.show', r.slug)"
                                        class="transition hover:text-red-400"
                                    >
                                        {{ r.driver }}
                                    </Link>
                                    <span v-else>{{ r.driver }}</span>
                                    <span v-if="r.team" class="ml-1 text-xs text-zinc-500">{{ r.team }}</span>
                                    <span v-if="r.fastest_lap" title="Най-бърза обиколка">🔥</span>
                                </td>
                                <td v-if="showsTime" class="px-4 py-2.5 text-right tabular-nums text-zinc-300">{{ r.time ?? '—' }}</td>
                                <td v-if="showsPoints" class="px-4 py-2.5 text-right font-medium tabular-nums text-white">{{ r.points || '' }}</td>
                            </tr>
                        </tbody>
                    </table>
                </TableShell>

                <!-- Класацията казва КОЙ е спечелил; анализът казва защо.
                     Линк, не втора секция: графиките искат цялата ширина. -->
                <Link
                    v-if="hasDataRecap && hasRoute('racedata.show')"
                    :href="route('racedata.show', race.id)"
                    class="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 transition duration-200 hover:border-red-600/50 hover:bg-zinc-900"
                >
                    <span>
                        <span class="block font-medium text-white">Какво казват данните</span>
                        <span class="block text-sm text-zinc-500">Стратегии, темпо по обиколки и спечелени позиции</span>
                    </span>
                    <span class="shrink-0 text-red-500" aria-hidden="true">→</span>
                </Link>
            </div>

            <aside class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
                <h2 class="mb-1 font-display text-lg font-bold text-white">Твоята прогноза</h2>

                <p v-if="lockDeadline" class="mb-4 text-xs text-zinc-500">
                    Заключване: {{ lockDeadline }}
                </p>

                <!-- Гостът вижда самата форма в заключен вид, вместо един ред
                     текст: „влез за да подадеш прогноза“ не обяснява какво е
                     лигата, а формата го показва за секунда. -->
                <template v-if="!user">
                    <p class="mb-3 text-sm text-zinc-400">
                        Познай подиума, pole позицията и най-бързата обиколка. Точките се
                        трупат през целия сезон.
                    </p>

                    <div class="pointer-events-none select-none opacity-60" aria-hidden="true">
                        <PredictionForm
                            :race-id="race.id"
                            :drivers="drivers"
                            :prediction="null"
                            :locked="true"
                        />
                    </div>

                    <Link
                        :href="route('register')"
                        class="mt-3 block rounded-lg bg-red-600 px-4 py-2.5 text-center font-semibold text-white transition hover:bg-red-500"
                    >
                        Регистрирай се и подай прогноза
                    </Link>
                    <p class="mt-2 text-center text-xs text-zinc-500">
                        Вече имаш акаунт?
                        <Link :href="route('login')" class="font-medium text-red-500 hover:text-red-400">Влез</Link>
                    </p>
                </template>

                <!-- `race.finished`, а не голо `finished`: последното не е проп и
                     Vue го резолвваше до undefined, така че блокът с точките
                     никога не се рендираше и играчът виждаше „заключени“. -->
                <template v-else-if="race.finished && userPrediction">
                    <div class="rounded-lg border border-zinc-800 bg-black/40 p-4 text-center">
                        <div class="font-display text-3xl font-black text-red-600">{{ userPrediction.points ?? 0 }}</div>
                        <div class="text-xs uppercase tracking-wide text-zinc-500">точки за това състезание</div>
                    </div>

                    <!-- Разбивката пътуваше до браузъра и не се рендираше никъде.
                         Тя е наградата: показва кое си познал, не само сбора. -->
                    <PredictionBreakdown
                        class="mt-3"
                        :breakdown="userPrediction.breakdown"
                        :total="userPrediction.points ?? 0"
                    />

                    <!-- При 78 регистрирани единственият реален канал за растеж
                         е някой да сподели резултата си някъде. -->
                    <SharePredictionButton
                        v-if="user"
                        :race-name="race.name_bg ?? race.name"
                        :user-name="user.name"
                        :points="userPrediction.points ?? 0"
                        :breakdown="userPrediction.breakdown"
                        :rank="userRaceRank"
                    />

                    <Link
                        v-if="hasRoute('leaderboard')"
                        :href="route('leaderboard')"
                        class="mt-3 block text-center text-sm font-medium text-red-500 transition hover:text-red-400"
                    >
                        Виж класирането →
                    </Link>
                </template>

                <template v-else-if="locked">
                    <p class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                        Прогнозите са заключени.
                    </p>
                </template>

                <PredictionForm
                    v-else
                    :race-id="race.id"
                    :drivers="drivers"
                    :prediction="userPrediction"
                    :locked="locked"
                />
            </aside>
        </div>

        <nav
            v-if="neighbours.prev || neighbours.next"
            class="mt-8 flex flex-wrap items-stretch gap-3"
            aria-label="Съседни кръгове"
        >
            <Link
                v-if="neighbours.prev"
                :href="route('races.show', neighbours.prev.id)"
                class="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition hover:border-red-600/50"
            >
                <div class="text-xs uppercase tracking-wide text-zinc-500">← Кръг {{ neighbours.prev.round }}</div>
                <div class="mt-0.5 truncate font-semibold text-white">{{ neighbours.prev.name }}</div>
            </Link>
            <Link
                v-if="neighbours.next"
                :href="route('races.show', neighbours.next.id)"
                class="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-right transition hover:border-red-600/50"
            >
                <div class="text-xs uppercase tracking-wide text-zinc-500">Кръг {{ neighbours.next.round }} →</div>
                <div class="mt-0.5 truncate font-semibold text-white">{{ neighbours.next.name }}</div>
            </Link>
        </nav>
    </PublicLayout>
</template>
