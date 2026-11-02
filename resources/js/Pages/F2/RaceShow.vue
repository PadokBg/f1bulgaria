<script setup>
import FlagIcon from '@/Components/FlagIcon.vue';
import TableShell from '@/Components/UI/TableShell.vue';
import PublicLayout from '@/Layouts/PublicLayout.vue';
import { hasRoute } from '@/utils/routes';
import { Link } from '@inertiajs/vue3';

const props = defineProps({
    race: { type: Object, required: true },
    sessionType: { type: String, required: true },
    sessionLabel: { type: String, required: true },
    isRace: { type: Boolean, default: false },
    // [{ segment, label }] в реда на уикенда — тренировка, квалификация,
    // спринт, главно. Монако добавя и двете групи на квалификацията.
    sessions: { type: Array, default: () => [] },
    pole: { type: Object, default: null },
    fastestLap: { type: Object, default: null },
    results: { type: Array, default: () => [] },
});

const rowClass = (p) => ({ 1: 'bg-amber-500/10', 2: 'bg-zinc-400/10', 3: 'bg-orange-500/10' })[p] ?? '';
</script>

<template>

    <PublicLayout>
        <Link :href="route('f2.calendar.year', race.season)" class="text-sm text-zinc-500 transition hover:text-zinc-300">← Календар F2 {{ race.season }}</Link>

        <!-- Hero -->
        <section class="mt-3 rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 to-black p-6">
            <div class="flex flex-wrap items-center gap-3">
                <span class="rounded-full bg-zinc-800 px-3 py-1 text-sm font-bold tabular-nums">Кръг {{ race.round }}</span>
                <h1 class="font-display text-2xl font-black sm:text-3xl">{{ race.location }} <span class="text-red-600">{{ race.season }}</span></h1>
                <span class="rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wide" :class="isRace ? 'bg-red-600/20 text-red-400' : 'bg-sky-500/20 text-sky-400'">{{ sessionLabel }}</span>
            </div>

            <div class="mt-3 flex flex-wrap gap-2 text-sm">
                <Link v-for="s in sessions" :key="s.segment" :href="route('f2.race', [race.slug, s.segment])"
                    class="rounded-lg px-3 py-2 font-medium transition"
                    :class="sessionType === s.segment
                        ? (s.segment.startsWith('feature') ? 'bg-red-600 text-white' : 'bg-sky-600 text-white')
                        : 'bg-zinc-900 text-zinc-400 hover:text-white'">{{ s.label }}</Link>
                <Link v-if="race.circuit_jolpica_id && hasRoute('circuits.show')" :href="route('circuits.show', race.circuit_jolpica_id)"
                    class="rounded-lg bg-zinc-900 px-3 py-2 font-medium text-zinc-400 transition hover:text-white">Пистата →</Link>
            </div>

            <div class="mt-4 flex flex-wrap gap-3">
                <div v-if="pole" class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-2 text-sm">
                    <span class="text-zinc-500">Pole:</span> <span class="font-semibold text-white"><FlagIcon :code="pole.flag" class="mr-1" />{{ pole.driver }}</span>
                </div>
                <div v-if="fastestLap" class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-2 text-sm">
                    <span class="text-zinc-500">⏱️ Най-бърза:</span> <span class="font-semibold text-white"><FlagIcon :code="fastestLap.flag" class="mr-1" />{{ fastestLap.driver }}</span>
                    <span v-if="fastestLap.time" class="tabular-nums text-purple-400"> {{ fastestLap.time }}</span>
                </div>
            </div>
        </section>

        <!-- Results -->
        <TableShell class="mt-6">
            <!-- Всички колони са винаги видими — на тясно таблицата скролва
                 хоризонтално (TableShell), вместо да крие Отбор/Старт. -->
            <table class="w-full whitespace-nowrap text-sm">
                <thead class="bg-zinc-900/80 text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                        <th scope="col" class="px-3 py-2 text-left">Поз.</th>
                        <th scope="col" class="px-2 py-2 text-left">#</th>
                        <th scope="col" class="px-3 py-2 text-left">Пилот</th>
                        <th scope="col" class="px-3 py-2 text-left">Отбор</th>
                        <th scope="col" class="px-2 py-2 text-right">Старт</th>
                        <th scope="col" class="px-3 py-2 text-right">Време/Изоставане</th>
                        <th scope="col" class="px-2 py-2 text-right">Точки</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-zinc-800/60">
                    <tr v-for="r in results" :key="r.slug + r.position" :class="[rowClass(r.position), r.is_bulgarian ? 'ring-1 ring-inset ring-emerald-500/40' : '']">
                        <td class="px-3 py-2.5 font-bold tabular-nums text-white">{{ r.position ?? r.status }}</td>
                        <td class="px-2 py-2.5 tabular-nums text-zinc-500">{{ r.car_number }}</td>
                        <td class="px-3 py-2.5 font-semibold text-white">
                            <Link v-if="r.slug && hasRoute('f2.drivers.show')" :href="route('f2.drivers.show', r.slug)" class="transition hover:text-red-400">
                                <FlagIcon :code="r.flag" class="mr-1" />{{ r.driver }}
                            </Link>
                            <span v-else><FlagIcon :code="r.flag" class="mr-1" />{{ r.driver }}</span>
                            <span v-if="r.is_bulgarian" class="sr-only">(български пилот)</span>
                            <span v-if="r.fastest_lap" title="Най-бърза обиколка" class="ml-1 text-purple-400"><span aria-hidden="true">⏱️</span><span class="sr-only">Най-бърза обиколка</span></span>
                        </td>
                        <td class="px-3 py-2.5 text-zinc-400">{{ r.team }}</td>
                        <td class="px-2 py-2.5 text-right tabular-nums text-zinc-400">{{ r.grid ?? '—' }}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums text-zinc-300">{{ r.time_or_gap ?? r.status }}</td>
                        <td class="px-2 py-2.5 text-right font-bold tabular-nums text-white">{{ r.points || '' }}</td>
                    </tr>
                </tbody>
            </table>
        </TableShell>
    </PublicLayout>
</template>
