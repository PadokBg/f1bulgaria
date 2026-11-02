<script setup>
import FlagIcon from '@/Components/FlagIcon.vue';
import EmptyState from '@/Components/UI/EmptyState.vue';
import SeasonSelect from '@/Components/UI/SeasonSelect.vue';
import PublicLayout from '@/Layouts/PublicLayout.vue';
import { podiumClass } from '@/utils/racing';
import { hasRoute } from '@/utils/routes';
import { Link, router } from '@inertiajs/vue3';

const props = defineProps({
    season: Number,
    seasons: { type: Array, default: () => [] },
    rounds: { type: Array, default: () => [] },
});

const goToSeason = (e) => router.visit(route('f2.calendar.year', e.target.value));

// Ключът е и отрязъкът в URL-а на класацията. Спринтът и главното са винаги
// (празните показват „Предстои“), второто главно — само където го има.
const raceCards = (round) => [
    { key: 'sprint', label: 'Спринт', session: round.sprint },
    { key: 'feature', label: 'Главно', session: round.feature },
    ...(round.feature_2 ? [{ key: 'feature-2', label: 'Второ главно', session: round.feature_2 }] : []),
];
</script>

<template>

    <PublicLayout>
        <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div>
                <Link :href="route('f2')" class="text-sm text-zinc-500 transition hover:text-zinc-300">← Формула 2</Link>
                <h1 class="mt-1 font-display text-2xl font-black sm:text-3xl">Календар Формула 2 <span class="text-red-600">{{ season }}</span></h1>
            </div>
            <SeasonSelect v-if="seasons.length" :seasons="seasons" :selected="season" @change="goToSeason" />
        </div>

        <EmptyState v-if="rounds.length === 0">Няма данни за този сезон.</EmptyState>

        <div class="grid gap-4">
            <div v-for="r in rounds" :key="r.round" class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
                <div class="mb-3 flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-sm font-bold tabular-nums">{{ r.round }}</span>
                        <h2 class="font-display text-lg font-bold text-white">{{ r.location }}</h2>
                    </div>
                    <Link
                        v-if="r.circuit_jolpica_id && hasRoute('circuits.show')"
                        :href="route('circuits.show', r.circuit_jolpica_id)"
                        class="text-xs font-medium text-red-500 transition hover:text-red-400"
                    >
                        Пистата →
                    </Link>
                </div>

                <div class="grid gap-3 sm:grid-cols-2">
                    <div v-for="card in raceCards(r)" :key="card.key" class="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                        <div class="mb-2 flex items-center justify-between">
                            <span class="text-xs font-bold uppercase tracking-wide" :class="card.key.startsWith('feature') ? 'text-red-400' : 'text-sky-400'">
                                {{ card.label }}
                            </span>
                            <Link
                                v-if="card.session"
                                :href="route('f2.race', [r.slug, card.key])"
                                class="text-xs text-zinc-500 transition hover:text-zinc-300"
                            >
                                Резултати →
                            </Link>
                        </div>
                        <div v-if="card.session" class="space-y-1">
                            <div v-for="p in card.session.podium" :key="p.position" class="flex items-center gap-2 text-sm">
                                <span class="w-4 font-bold tabular-nums" :class="podiumClass(p.position) || 'text-zinc-500'">{{ p.position }}</span>
                                <span class="text-zinc-200"><FlagIcon :code="p.flag" class="mr-1" />{{ p.driver }}</span>
                            </div>
                            <div v-if="card.session.date" class="mt-1 text-xs text-zinc-500">{{ card.session.date }}</div>
                        </div>
                        <div v-else class="text-sm text-zinc-500">Предстои</div>
                    </div>
                </div>
            </div>
        </div>
    </PublicLayout>
</template>
