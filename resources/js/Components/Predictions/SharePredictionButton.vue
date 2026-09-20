<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
    raceName: { type: String, required: true },
    userName: { type: String, required: true },
    points: { type: Number, default: 0 },
    // breakdown_json от PredictionScore; null преди кръгът да е точкуван.
    breakdown: { type: Object, default: null },
    // { rank, total } — null докато няма точкуване.
    rank: { type: Object, default: null },
});

const busy = ref(false);
const failed = ref(false);

// Същият ред като в PredictionBreakdown, за да е разпознаваем на картичката.
const LABELS = [
    ['p1', 'Победител'],
    ['p2', 'Второ място'],
    ['p3', 'Трето място'],
    ['pole', 'Pole позиция'],
    ['fastest_lap', 'Най-бърза обиколка'],
    ['dnf', 'Брой отпаднали'],
    ['safety_car', 'Safety car'],
];

const rows = computed(() => {
    if (!props.breakdown) {
        return [];
    }

    return LABELS
        .filter(([key]) => props.breakdown[key] !== undefined)
        .map(([key, label]) => ({ label, hit: (Number(props.breakdown[key]) || 0) > 0 }));
});

const share = async () => {
    if (busy.value) {
        return;
    }

    busy.value = true;
    failed.value = false;

    try {
        const { buildPredictionCard } = await import('@/predictions/resultCard.js');
        const blob = await buildPredictionCard({
            raceName: props.raceName,
            userName: props.userName,
            points: props.points,
            rank: props.rank?.rank ?? null,
            total: props.rank?.total ?? null,
            rows: rows.value,
        });

        const file = new File([blob], 'padok-prognoza.png', { type: 'image/png' });

        // На телефон Web Share праща направо към Месинджър/Вайбър; на десктоп
        // остава свалянето, защото canShare с файлове там почти никъде го няма.
        if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file] });
        } else {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'padok-prognoza.png';
            link.click();
            URL.revokeObjectURL(url);
        }
    } catch (e) {
        // Отказано споделяне не е грешка — само истинските провали се показват.
        failed.value = e?.name !== 'AbortError';
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div v-if="breakdown">
        <button
            type="button"
            class="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800/60 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-700/60 disabled:opacity-50"
            :disabled="busy"
            @click="share"
        >
            {{ busy ? 'Правим картичката…' : 'Сподели резултата' }}
        </button>

        <p v-if="failed" class="mt-1.5 text-center text-xs text-amber-400" role="alert">
            Картичката не се получи. Опитай пак.
        </p>
    </div>
</template>
