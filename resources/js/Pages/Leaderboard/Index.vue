<script setup>
import ScoringRules from '@/Components/Predictions/ScoringRules.vue';
import EmptyState from '@/Components/UI/EmptyState.vue';
import TableShell from '@/Components/UI/TableShell.vue';
import PublicLayout from '@/Layouts/PublicLayout.vue';
import { hasRoute } from '@/utils/routes';
import { Link, usePage } from '@inertiajs/vue3';
import { computed } from 'vue';

const canOpenProfile = computed(() => hasRoute('profiles.show'));

defineProps({
    season: Number,
    leaderboard: Array,
});

const user = computed(() => usePage().props.auth?.user);

const podium = (pos) => ({
    1: 'border-l-2 border-amber-400 bg-gradient-to-r from-amber-500/10 to-transparent',
    2: 'border-l-2 border-zinc-300 bg-gradient-to-r from-zinc-400/10 to-transparent',
    3: 'border-l-2 border-orange-700 bg-gradient-to-r from-orange-800/10 to-transparent',
})[pos] ?? 'bg-zinc-900/40';
</script>

<template>
    <!-- meta/og таговете идват сървърно от App\Support\Seo (виж app.blade.php). -->

    <PublicLayout>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h1 class="font-display text-2xl font-black sm:text-3xl">Лигата на прогнозите <span class="text-red-600">{{ season }}</span></h1>
            <Link
                v-if="user"
                :href="route('predictions.index')"
                class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
            >
                Моите прогнози →
            </Link>
            <Link
                v-else
                :href="route('register')"
                class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
            >
                Включи се в играта
            </Link>
        </div>
        <!-- Едното изречение „точен подиум, pole…" внушаваше, че само точното
             място носи точки, а частичните 5 т. не се виждаха никъде. -->
        <ScoringRules anchor="kak-se-tochkuva" class="mb-6" />

        <EmptyState v-if="leaderboard.length === 0">
            Все още няма точкувани прогнози.
        </EmptyState>

        <TableShell v-else>
            <table class="w-full whitespace-nowrap text-sm">
                <thead class="bg-zinc-900/80 text-left text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                        <th class="px-4 py-2.5 w-12">#</th>
                        <th class="px-4 py-2.5">Играч</th>
                        <th class="px-4 py-2.5 text-center">Прогнози</th>
                        <th class="px-4 py-2.5 text-right">Точки</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-zinc-800/60">
                    <tr
                        v-for="row in leaderboard"
                        :key="row.position"
                        class="transition duration-200 hover:bg-zinc-800/40"
                        :class="podium(row.position)"
                    >
                        <td class="px-4 py-2.5 font-bold tabular-nums text-zinc-400">
                            <template v-if="row.position === 1">
                                <span aria-hidden="true">🏆</span>
                                <span class="sr-only">1-во място</span>
                            </template>
                            <span v-else>{{ row.position }}</span>
                        </td>
                        <td class="px-4 py-2.5 font-semibold text-white">
                            <Link
                                v-if="canOpenProfile && row.id"
                                :href="route('profiles.show', row.id)"
                                class="transition hover:text-red-400"
                            >
                                {{ row.name }}
                            </Link>
                            <span v-else>{{ row.name }}</span>
                        </td>
                        <td class="px-4 py-2.5 text-center tabular-nums text-zinc-400">{{ row.predictions }}</td>
                        <td class="px-4 py-2.5 text-right font-bold tabular-nums text-white">{{ row.points }}</td>
                    </tr>
                </tbody>
            </table>
        </TableShell>
    </PublicLayout>
</template>
